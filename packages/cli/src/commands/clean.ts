import { realpathSync } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { exec } from "../lib/exec.ts";
import { PrNotFoundError, viewPullRequest } from "../lib/gh.ts";
import {
  type WorktreeEntry,
  assertValidRefName,
  getDefaultBranch,
  listWorktrees,
} from "../lib/git.ts";
import { sanitizeForLog } from "../lib/format.ts";
import { getShellMode } from "../lib/runtime.ts";

export interface CleanOptions {
  dryRun: boolean;
  state: ReadonlySet<"MERGED" | "CLOSED">;
  includeNoPr: boolean;
  yes: boolean;
  allowNoDefaultBranch: boolean;
}

/**
 * Seams for `cleanCommand` so tests can inject mocks. Defaults wire up the
 * real gh / git / vibe callers plus the real stdin / TTY / env probes.
 */
export interface CleanDeps {
  listWorktrees: typeof listWorktrees;
  getDefaultBranch: typeof getDefaultBranch;
  viewPullRequest: typeof viewPullRequest;
  exec: typeof exec;
  log: (msg: string) => void;
  cwd: () => string;
  isStdoutTty: () => boolean;
  isShellMode: () => boolean;
  prompt: (line: string) => Promise<string>;
  /**
   * Resolve a path through symlinks to its canonical form. Defaulted to
   * `fs.realpathSync.native` so the comparison in `pathsRefSameDir` can
   * recognise that `process.cwd()` (which may report a symlinked path like
   * `/var/...`) and `entry.path` (which `git worktree list` already
   * `realpath`'d to `/private/var/...`) refer to the same directory.
   */
  realpath: (p: string) => string;
}

/**
 * Compare two paths after resolving symlinks. Defends against macOS
 * `/private/var/...` vs `/var/...` divergence and user-installed symlinks
 * (`~/work -> /Users/.../projects`) where `git worktree list` and
 * `process.cwd()` report different strings for the same directory.
 *
 * If `realpath` throws for either side (path no longer exists, EACCES, …)
 * we log and fall back to raw string equality — never let a realpath error
 * open a deletion path.
 */
function pathsRefSameDir(
  a: string,
  b: string,
  realpath: (p: string) => string,
  log: (msg: string) => void,
): boolean {
  try {
    return realpath(a) === realpath(b);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `Warning: realpath failed during cwd comparison (${sanitizeForLog(message)}); ` +
        "falling back to raw path equality.",
    );
    return a === b;
  }
}

async function defaultPrompt(line: string): Promise<string> {
  process.stderr.write(line);
  const rl = readline.createInterface({ input: process.stdin });
  try {
    for await (const answer of rl) {
      return answer;
    }
    return "";
  } finally {
    rl.close();
  }
}

const defaultDeps: CleanDeps = {
  listWorktrees,
  getDefaultBranch,
  viewPullRequest,
  exec,
  log: (msg) => console.error(msg),
  cwd: () => process.cwd(),
  isStdoutTty: () => process.stdout.isTTY === true,
  isShellMode: () => getShellMode(),
  prompt: defaultPrompt,
  realpath: realpathSync.native,
};

type Plan =
  | { kind: "delete"; entry: WorktreeEntry; prLabel: string }
  | { kind: "skip"; entry: WorktreeEntry; reason: string };

export async function cleanCommand(
  opts: CleanOptions,
  deps: CleanDeps = defaultDeps,
): Promise<number> {
  // `clean` emits no shell `cd` line; under shell mode the parent would just
  // eval an empty script. Refuse rather than silently no-op.
  const isShellMode = deps.isShellMode();
  if (isShellMode) {
    deps.log("gh vibe clean: refusing to run under shell mode (no cd to emit).");
    return 2;
  }

  const isTty = deps.isStdoutTty();
  const canRunNonInteractive = isTty || opts.yes;
  if (!canRunNonInteractive) {
    deps.log(
      "gh vibe clean: refusing to run non-interactively without --yes " +
        "(would skip the typed-<count> confirmation prompt).",
    );
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

  // `git worktree list` always returns the main worktree first; an empty
  // result means we're not in a git repo at all (or the listing failed
  // silently). Either way, no candidates can possibly be derived.
  const mainEntry = entries[0];
  if (!mainEntry) {
    deps.log(
      "Error: Could not determine main worktree (no worktrees listed).",
    );
    return 2;
  }
  const mainPath = mainEntry.path;

  let defaultBranch: string | null;
  try {
    defaultBranch = await deps.getDefaultBranch();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.allowNoDefaultBranch) {
      deps.log(
        `Warning: could not resolve default branch (${message}); ` +
          "proceeding without that defense-in-depth check.",
      );
      defaultBranch = null;
    } else {
      deps.log(`Error: ${message}`);
      return 2;
    }
  }

  const mainDir = path.dirname(mainPath);
  const mainBasename = path.basename(mainPath);
  const siblingPrefix = `${mainBasename}-`;

  const candidates: WorktreeEntry[] = [];
  for (const entry of entries) {
    if (entry.isMain) continue;
    if (entry.isBare) continue;
    if (entry.isDetached) continue;
    const branch = entry.branch;
    if (!branch) continue;

    const entryDir = path.dirname(entry.path);
    const entryBasename = path.basename(entry.path);
    const isSibling = entryDir === mainDir;
    if (!isSibling) continue;
    const hasSiblingPrefix = entryBasename.startsWith(siblingPrefix);
    if (!hasSiblingPrefix) continue;

    const isDefaultBranch =
      defaultBranch !== null && branch === defaultBranch;
    if (isDefaultBranch) continue;

    // WHY: when `defaultBranch === null` (resolution failed + waiver flag),
    // we lose the primary defence against deleting a worktree whose branch
    // is the actual default. The `isMain` filter still protects the real
    // main worktree, but a *sibling-prefixed* worktree happening to track
    // `main` / `master` / `trunk` / `develop` would slip through. Skip such
    // branches with a logged warning rather than risk a destructive delete.
    const isLikelyDefaultName =
      defaultBranch === null &&
      (branch === "main" ||
        branch === "master" ||
        branch === "trunk" ||
        branch === "develop");
    if (isLikelyDefaultName) {
      deps.log(
        `Skipping ${sanitizeForLog(entry.path)}: branch '${sanitizeForLog(branch)}' ` +
          "is a likely default branch name and the real default could not be resolved.",
      );
      continue;
    }

    const isDashPrefixed = branch.startsWith("-");
    if (isDashPrefixed) {
      deps.log(
        `Skipping ${sanitizeForLog(entry.path)}: branch '${sanitizeForLog(branch)}' starts with '-'.`,
      );
      continue;
    }

    try {
      assertValidRefName(branch);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(
        `Skipping ${sanitizeForLog(entry.path)}: ${sanitizeForLog(message)}.`,
      );
      continue;
    }

    candidates.push(entry);
  }

  const isEmpty = candidates.length === 0;
  if (isEmpty) {
    deps.log("No vibe-managed worktrees to clean.");
    return 0;
  }

  // --- Phase 2: query PR state for each candidate ---
  const cwd = deps.cwd();
  const plans: Plan[] = [];
  let transientFailures = 0;

  for (const entry of candidates) {
    const isCwd = pathsRefSameDir(entry.path, cwd, deps.realpath, deps.log);
    if (isCwd) {
      plans.push({ kind: "skip", entry, reason: "is-cwd" });
      continue;
    }
    const branch = entry.branch as string;
    try {
      const pr = await deps.viewPullRequest(branch);
      const isInState = (opts.state as ReadonlySet<string>).has(pr.state);
      if (isInState) {
        plans.push({
          kind: "delete",
          entry,
          prLabel: `PR #${pr.number} (${pr.state})`,
        });
      } else {
        plans.push({
          kind: "skip",
          entry,
          reason: `state=${pr.state.toLowerCase()}`,
        });
      }
    } catch (err) {
      const isNotFound = err instanceof PrNotFoundError;
      if (isNotFound) {
        if (opts.includeNoPr) {
          plans.push({ kind: "delete", entry, prLabel: "<no PR>" });
        } else {
          plans.push({ kind: "skip", entry, reason: "no-pr" });
        }
        continue;
      }
      transientFailures += 1;
      const message = err instanceof Error ? err.message : String(err);
      plans.push({
        kind: "skip",
        entry,
        reason: `transient: ${message}`,
      });
    }
  }

  const deletions = plans.filter(
    (p): p is Extract<Plan, { kind: "delete" }> => p.kind === "delete",
  );

  for (const plan of plans) {
    if (plan.kind === "delete") {
      const branch = plan.entry.branch ?? "<no branch>";
      deps.log(
        `delete  ${sanitizeForLog(plan.entry.path)} [${sanitizeForLog(branch)}] -> ${plan.prLabel}`,
      );
    } else {
      const branch = plan.entry.branch ?? "<no branch>";
      deps.log(
        `skip    ${sanitizeForLog(plan.entry.path)} [${sanitizeForLog(branch)}] (${sanitizeForLog(plan.reason)})`,
      );
    }
  }

  if (opts.dryRun) {
    deps.log(
      `Dry run: would remove ${deletions.length}, skip ${plans.length - deletions.length}.`,
    );
    return 0;
  }

  const needsConfirm =
    isTty && !opts.yes && deletions.length > 0;
  if (needsConfirm) {
    const count = deletions.length;
    let answer: string;
    try {
      answer = await deps.prompt(
        `Type ${count} to confirm deletion of ${count} worktree(s): `,
      );
    } catch (err) {
      // Treat a rejected prompt (Ctrl-C / readline EOF / signal) as an abort
      // rather than a crash. Safer than propagating: nothing has been deleted
      // yet and the caller's screen is already noisy from the SIGINT.
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`Aborted (prompt error: ${sanitizeForLog(message)}).`);
      return 0;
    }
    const isConfirmed = answer.trim() === String(count);
    if (!isConfirmed) {
      deps.log("Aborted.");
      return 0;
    }
  }

  let removed = 0;
  let skipped = 0;
  let failures = transientFailures;

  for (const plan of plans) {
    if (plan.kind === "skip") {
      skipped += 1;
      continue;
    }
    const result = await deps.exec(
      "vibe",
      ["clean", "-f", "--delete-branch"],
      { cwd: plan.entry.path, stdio: "inherit" },
    );
    const isFailed = result.exitCode !== 0;
    if (isFailed) {
      failures += 1;
      deps.log(
        `Failed: vibe clean exited ${result.exitCode} for ${sanitizeForLog(plan.entry.path)}.`,
      );
      continue;
    }
    removed += 1;
  }

  deps.log(`Removed ${removed}, skipped ${skipped}, failed ${failures}.`);
  const hasFailures = failures > 0;
  return hasFailures ? 1 : 0;
}
