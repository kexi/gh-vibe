import { ExecError, execOrThrow } from "./exec.ts";
import { maskSecrets, stripAnsi } from "./format.ts";

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
  headRepository: { name: string } | null;
  headRepositoryOwner: { login: string } | null;
  state: "OPEN" | "CLOSED" | "MERGED";
}

const PR_FIELDS = [
  "number",
  "title",
  "url",
  "headRefName",
  "baseRefName",
  "isCrossRepository",
  "headRepository",
  "headRepositoryOwner",
  "state",
].join(",");

/** @internal Exported for unit tests; not part of the public API. */
export function formatGhError(
  err: ExecError,
  ctx: { prRef?: string; ownerRepo?: string },
): string {
  const cleanStderr = stripAnsi(err.stderr);
  const cleanStdout = stripAnsi(err.stdout);

  const isPrNotFound = cleanStderr.includes(
    "Could not resolve to a PullRequest",
  );
  if (isPrNotFound) {
    const prNumber = ctx.prRef ? `#${ctx.prRef}` : "";
    const repoSuffix = ctx.ownerRepo ? ` in ${ctx.ownerRepo}` : "";
    const subject = ["PR", prNumber].filter(Boolean).join(" ");
    return `${subject} not found${repoSuffix}.`;
  }

  const isNotInRepo = cleanStderr.includes("not a git repository");
  if (isNotInRepo) {
    return "gh vibe must run from inside a git repository.";
  }

  // Defensive: in case gh ever echoes the original `--json <fields>` arg list
  // in its error output, strip it so internal field names don't leak to users.
  const errorOutput = (cleanStderr || cleanStdout).trim();
  const stripped = errorOutput.replace(/--json \S+/g, "").replace(/\s+/g, " ").trim();
  return maskSecrets(stripped) || `gh exited with code ${err.exitCode}`;
}

/**
 * Fetch a PR's metadata via `gh pr view`.
 *
 * @param ownerRepo Optional `owner/repo`; when supplied, "not found" errors
 *   include the repo for clarity. Omit when the caller doesn't yet know it.
 */
export async function viewPullRequest(
  prRef: string,
  ownerRepo?: string,
): Promise<PullRequest> {
  try {
    const out = await execOrThrow("gh", [
      "pr",
      "view",
      prRef,
      "--json",
      PR_FIELDS,
    ]);
    return JSON.parse(out) as PullRequest;
  } catch (err) {
    const isExecError = err instanceof ExecError;
    if (isExecError) {
      // Keep the raw ExecError as `cause` so a future --verbose flag can
      // expose stderr/stdout without re-running the command.
      throw new Error(formatGhError(err, { prRef, ownerRepo }), { cause: err });
    }
    throw err;
  }
}
