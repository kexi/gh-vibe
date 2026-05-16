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
  // Test seam (defaults to the real `execOrThrow`); not part of the public API.
  _exec: typeof execOrThrow = execOrThrow,
): Promise<void> {
  try {
    // The `--` separator prevents git from interpreting a refspec that begins
    // with `-` as an option, even though we already reject dash-prefixed
    // arguments at the CLI boundary.
    await _exec("git", ["fetch", remote, "--", refspec]);
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

/**
 * Resolve the repository's default branch via the symbolic ref
 * `refs/remotes/origin/HEAD`. Requires the user (or `gh clone`) to have set it
 * — `git remote set-head origin --auto` recreates it after the fact.
 *
 * Only call when `--base` was not supplied; user-supplied base values bypass
 * this.
 */
export async function getDefaultBranch(
  // Test seam; not part of the public API.
  _exec: typeof execOrThrow = execOrThrow,
): Promise<string> {
  try {
    const out = await _exec("git", [
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const trimmed = out.trim();
    // git returns e.g. `origin/main`; strip the remote prefix.
    const remotePrefix = "origin/";
    const hasRemotePrefix = trimmed.startsWith(remotePrefix);
    return hasRemotePrefix ? trimmed.slice(remotePrefix.length) : trimmed;
  } catch (err) {
    const isExecError = err instanceof ExecError;
    if (!isExecError) throw err;
    const cleanStderr = stripAnsi(err.stderr);
    const isNotSymbolicRef = cleanStderr.includes("is not a symbolic ref");
    if (isNotSymbolicRef) {
      throw new Error(
        "Could not determine default branch. " +
          "Run `git remote set-head origin --auto` or pass --base explicitly.",
        { cause: err },
      );
    }
    // Fall back to masked / sanitised stderr (mirrors `formatGitError`); never
    // leak raw stderr because it may contain tokens.
    const fallback =
      maskSecrets(cleanStderr.trim()) || `git exited with code ${err.exitCode}`;
    throw new Error(fallback, { cause: err });
  }
}

/**
 * Validate that `name` is a syntactically legal git ref name (mirrors the
 * single-segment-allowed subset of `git check-ref-format --allow-onelevel`),
 * so single-segment refs like `main` are accepted alongside `feature/foo`.
 *
 * Implemented inline (~30–80ms faster than spawning git per call). Rejected
 * shapes — drawn from `git-check-ref-format(1)` — include:
 *   - `..` anywhere
 *   - any ASCII control char (\x00–\x20, \x7f), space, or any of `~^:?*[\`
 *   - `@{` sequence
 *   - leading-`.` in any segment (`^.` or `/.`)
 *   - trailing `.` or trailing `/`
 *   - consecutive `/`
 *   - any path component ending in `.lock` (suffix `.lock` or `.lock/` mid-path)
 *   - empty string
 *   - leading `-` (would be parsed by git as a CLI flag)
 *   - leading `/`
 *
 * MUST be called on user-supplied refs (e.g. `--base`). Internally derived
 * branch names that are by-construction valid don't need this.
 */
const INVALID_REF_RE =
  /\.\.|[\x00-\x20\x7f ~^:?*\[\\]|@\{|(?:^|\/)\.|\.$|\/\/|\.lock(?:\/|$)/;

export function assertValidRefName(name: string): void {
  const isEmpty = name.length === 0;
  const startsDash = name.startsWith("-");
  const startsSlash = name.startsWith("/");
  const endsSlash = name.endsWith("/");
  const matchesInvalid = INVALID_REF_RE.test(name);
  const isInvalid =
    isEmpty || startsDash || startsSlash || endsSlash || matchesInvalid;
  if (isInvalid) {
    throw new Error(`Invalid ref name: ${name}`);
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

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
  isBare: boolean;
  isDetached: boolean;
}

/** @internal Exported for unit tests; not part of the public API. */
export function parseWorktreeListAll(out: string): WorktreeEntry[] {
  const isEmpty = out.length === 0;
  if (isEmpty) return [];
  // `git worktree list --porcelain -z` uses NUL for line termination and a
  // double-NUL between groups. The first group is the main worktree.
  const groups = out.split("\0\0");
  const entries: WorktreeEntry[] = [];
  for (let i = 0; i < groups.length; i++) {
    const lines = groups[i].split("\0").filter((line) => line.length > 0);
    const isEmptyGroup = lines.length === 0;
    if (isEmptyGroup) continue;
    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    if (!worktreeLine) continue;
    const path = worktreeLine.slice("worktree ".length);
    const isBare = lines.includes("bare");
    const isDetached = lines.includes("detached");
    const branchLine = lines.find((line) => line.startsWith("branch refs/heads/"));
    const branch =
      isBare || isDetached || !branchLine
        ? null
        : branchLine.slice("branch refs/heads/".length);
    entries.push({
      path,
      branch,
      isMain: entries.length === 0,
      isBare,
      isDetached,
    });
  }
  return entries;
}

export async function listWorktrees(
  // Test seam; not part of the public API.
  _exec: typeof execOrThrow = execOrThrow,
): Promise<WorktreeEntry[]> {
  const out = await _exec("git", ["worktree", "list", "--porcelain", "-z"]);
  return parseWorktreeListAll(out);
}

export async function getMainWorktreePath(
  // Test seam; not part of the public API.
  _exec: typeof execOrThrow = execOrThrow,
): Promise<string> {
  const entries = await listWorktrees(_exec);
  const first = entries[0];
  if (!first) {
    throw new Error("Could not determine main worktree (no worktrees listed).");
  }
  return first.path;
}
