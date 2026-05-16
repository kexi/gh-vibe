import { ExecError, exec, execOrThrow } from "./exec.ts";
import { maskSecrets, stripAnsi } from "./format.ts";

/** @internal Exported for unit tests; not part of the public API. */
export function formatGitError(
  err: ExecError,
  ctx: { remote?: string; refspec?: string },
): string {
  const cleanStderr = stripAnsi(err.stderr);
  const cleanStdout = stripAnsi(err.stdout);

  const isRefNotFound = cleanStderr.includes("couldn't find remote ref");
  if (isRefNotFound) {
    // refspec may be "src" or "src:dst" — we want the source side only.
    const sourceRef = ctx.refspec ? ctx.refspec.split(":")[0] : undefined;
    const ref = sourceRef ? `'${sourceRef}'` : "ref";
    const at = ctx.remote ? ` on remote '${ctx.remote}'` : "";
    return `Branch ${ref} not found${at}.`;
  }

  const isAuthFailed =
    cleanStderr.includes("Authentication failed") ||
    cleanStderr.includes("Permission denied (publickey)");
  if (isAuthFailed) {
    return "git authentication failed. Check `gh auth status` or your SSH key.";
  }

  const errorOutput = (cleanStderr || cleanStdout).trim();
  return maskSecrets(errorOutput) || `git exited with code ${err.exitCode}`;
}

export async function fetchBranch(
  remote: string,
  refspec: string,
): Promise<void> {
  try {
    await execOrThrow("git", ["fetch", remote, refspec]);
  } catch (err) {
    const isExecError = err instanceof ExecError;
    if (isExecError) {
      // Keep the raw ExecError as `cause` so a future --verbose flag can
      // expose stderr/stdout without re-running the command.
      throw new Error(formatGitError(err, { remote, refspec }), { cause: err });
    }
    throw err;
  }
}

export async function localBranchExists(branch: string): Promise<boolean> {
  const result = await exec("git", [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  return result.exitCode === 0;
}

/** @internal Exported for unit tests; not part of the public API. */
export function parseWorktreeListZ(
  out: string,
  branch: string,
): string | null {
  // `git worktree list --porcelain -z` emits attribute lines terminated by
  // NUL (\0) and groups separated by a *double* NUL. Each group always begins
  // with a `worktree <path>` line; `branch refs/heads/<name>` appears in the
  // same group when the worktree is on a local branch.
  const targetBranchLine = `branch refs/heads/${branch}`;
  const groups = out.split("\0\0");
  for (const group of groups) {
    const lines = group.split("\0").filter((line) => line.length > 0);
    const isMatch = lines.includes(targetBranchLine);
    if (!isMatch) continue;
    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    if (!worktreeLine) continue;
    return worktreeLine.slice("worktree ".length);
  }
  return null;
}

/**
 * Resolve the on-disk path of the worktree currently checked out on `branch`,
 * or `null` if no worktree references it.
 *
 * Uses `-z` to keep paths with newlines or other oddities intact; callers that
 * intend to emit the result as a shell command must still run it through
 * `assertSafeShellPath`.
 */
export async function worktreePathForBranch(
  branch: string,
): Promise<string | null> {
  const out = await execOrThrow("git", [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  return parseWorktreeListZ(out, branch);
}
