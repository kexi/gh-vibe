import { type CiRollup, rollupCi } from "../lib/ci.ts";
import { sanitizeForLog } from "../lib/format.ts";
import {
  type PullRequestSummary,
  listPullRequests,
} from "../lib/gh.ts";
import {
  type WorktreeEntry,
  enumerateVibeWorktrees,
  getDefaultBranch,
  listWorktrees,
} from "../lib/git.ts";
import { getShellMode } from "../lib/runtime.ts";
import { renderTable } from "../lib/table.ts";

export interface ListOptions {
  json: boolean;
  stale: boolean;
  limit: number;
  allowNoDefaultBranch: boolean;
}

export interface ListDeps {
  listWorktrees: typeof listWorktrees;
  getDefaultBranch: typeof getDefaultBranch;
  listPullRequests: typeof listPullRequests;
  log: (msg: string) => void;
  writeStdout: (s: string) => void;
  isShellMode: () => boolean;
}

const defaultDeps: ListDeps = {
  listWorktrees,
  getDefaultBranch,
  listPullRequests,
  log: (msg) => console.error(msg),
  writeStdout: (s) => {
    process.stdout.write(s);
  },
  isShellMode: () => getShellMode(),
};

// Restricted to [1-9]\d{0,8} (1–9 decimal digits, no leading zero) so the
// regex itself rejects hex / exponential / zero-padded variants that
// `parseInt(_, 10)` would otherwise accept silently in `parseForkPrNumber`.
const FORK_PR_BRANCH_RE = /^pr\/([1-9]\d{0,8})\/[^/].*$/;
const PR_NUMBER_UPPER_BOUND = 1_000_000_000;

interface JoinedRow {
  entry: WorktreeEntry;
  pr: PullRequestSummary | null;
}

interface RenderRow {
  path: string;
  branch: string;
  prNumber: number | null;
  prState: "OPEN" | "CLOSED" | "MERGED" | null;
  mergeable: string | null;
  ci: CiRollup;
  review: string | null;
  isStale: boolean;
}

const HEADERS = [
  "PATH",
  "BRANCH",
  "PR",
  "STATE",
  "CI",
  "REVIEW",
  "STALE",
] as const;

function parseForkPrNumber(branch: string): number | null {
  const match = FORK_PR_BRANCH_RE.exec(branch);
  if (!match) return null;
  const captured = match[1];
  // Use `parseInt(_, 10)` — NEVER `Number(s)`. `Number("0x10")` would parse
  // hex and `Number("1e9")` exponential notation; the regex already excludes
  // both shapes, but this keeps that contract explicit.
  const n = parseInt(captured, 10);
  const isSafe =
    Number.isSafeInteger(n) && n > 0 && n <= PR_NUMBER_UPPER_BOUND;
  if (!isSafe) return null;
  return n;
}

function joinWorktreesWithPrs(
  entries: readonly WorktreeEntry[],
  prs: readonly PullRequestSummary[],
): JoinedRow[] {
  const byHeadRef = new Map<string, PullRequestSummary>();
  const byNumber = new Map<number, PullRequestSummary>();
  for (const pr of prs) {
    const isFirstByHead = !byHeadRef.has(pr.headRefName);
    if (isFirstByHead) byHeadRef.set(pr.headRefName, pr);
    byNumber.set(pr.number, pr);
  }

  const joined: JoinedRow[] = [];
  for (const entry of entries) {
    const branch = entry.branch;
    if (!branch) {
      joined.push({ entry, pr: null });
      continue;
    }
    const direct = byHeadRef.get(branch);
    if (direct) {
      joined.push({ entry, pr: direct });
      continue;
    }
    const forkNumber = parseForkPrNumber(branch);
    if (forkNumber !== null) {
      const forkPr = byNumber.get(forkNumber) ?? null;
      joined.push({ entry, pr: forkPr });
      continue;
    }
    joined.push({ entry, pr: null });
  }
  return joined;
}

function toRenderRow(joined: JoinedRow): RenderRow {
  const pr = joined.pr;
  const isStale = pr !== null && (pr.state === "MERGED" || pr.state === "CLOSED");
  return {
    path: joined.entry.path,
    branch: joined.entry.branch ?? "",
    prNumber: pr?.number ?? null,
    prState: pr?.state ?? null,
    mergeable: pr?.mergeable ?? null,
    ci: rollupCi(pr?.statusCheckRollup ?? null),
    review: pr?.reviewDecision ?? null,
    isStale,
  };
}

function renderJson(rows: readonly RenderRow[]): string {
  // Sanitize string fields before emitting so a malicious branch / path can't
  // smuggle escape codes through a JSON consumer that prints values raw.
  // Numeric and boolean fields (prNumber, isStale) carry no injection risk.
  const sanitized = rows.map((r) => ({
    path: sanitizeForLog(r.path),
    branch: sanitizeForLog(r.branch),
    prNumber: r.prNumber,
    prState: r.prState,
    mergeable: r.mergeable === null ? null : sanitizeForLog(r.mergeable),
    ci: r.ci,
    review: r.review === null ? null : sanitizeForLog(r.review),
    isStale: r.isStale,
  }));
  return JSON.stringify(sanitized);
}

function renderPlain(rows: readonly RenderRow[]): string {
  const tableRows = rows.map((r) => [
    r.path,
    r.branch,
    r.prNumber === null ? "-" : `#${r.prNumber}`,
    r.prState ?? "-",
    r.ci,
    r.review ?? "-",
    r.isStale ? "yes" : "no",
  ]);
  return renderTable(HEADERS, tableRows);
}

export async function listCommand(
  opts: ListOptions,
  deps: ListDeps = defaultDeps,
): Promise<number> {
  // SECURITY: shell-mode refusal MUST be the very first statement, before any
  // subprocess I/O. The wrapper would `eval` our stdout as a shell script and
  // a table / JSON payload would be catastrophic.
  const isShellMode = deps.isShellMode();
  if (isShellMode) {
    deps.log("gh vibe list: refusing to run under shell mode (no cd to emit).");
    return 2;
  }

  let entries: WorktreeEntry[];
  try {
    entries = await deps.listWorktrees();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log(`Error: ${message}`);
    return 2;
  }

  const mainEntry = entries[0];
  if (!mainEntry) {
    deps.log(
      "Error: Could not determine main worktree (no worktrees listed).",
    );
    return 2;
  }

  let defaultBranch: string | null;
  try {
    defaultBranch = await deps.getDefaultBranch();
  } catch (err) {
    // Soft-fail by default. `list` is read-only — losing the default-branch
    // skip rule has no destructive consequence, so we warn (unless suppressed)
    // and continue. `clean`'s fail-closed policy intentionally diverges.
    if (!opts.allowNoDefaultBranch) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(
        `Warning: could not resolve default branch (${message}); ` +
          "continuing without that filter.",
      );
    }
    defaultBranch = null;
  }

  const enumeration = enumerateVibeWorktrees({ entries, defaultBranch });

  // Filter stays in `list` (not `enumerateVibeWorktrees`) because `clean`'s
  // existing ANSI-in-path test asserts the opposite contract for its own flow.
  const safeCandidates: WorktreeEntry[] = [];
  for (const candidate of enumeration.candidates) {
    const hasUnsafeChar =
      candidate.path.includes("\n") || candidate.path.includes("\x1b");
    if (hasUnsafeChar) {
      deps.log(
        `Skipping ${sanitizeForLog(candidate.path)}: contains unsafe character (newline or escape).`,
      );
      continue;
    }
    safeCandidates.push(candidate);
  }

  let prs: PullRequestSummary[];
  try {
    prs = await deps.listPullRequests({ limit: opts.limit });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log(`Error: ${message}`);
    return 2;
  }

  const joined = joinWorktreesWithPrs(safeCandidates, prs);
  const allRows = joined.map(toRenderRow);
  const rows = opts.stale ? allRows.filter((r) => r.isStale) : allRows;

  if (opts.json) {
    deps.writeStdout(renderJson(rows));
    return 0;
  }
  deps.writeStdout(`${renderPlain(rows)}\n`);
  return 0;
}
