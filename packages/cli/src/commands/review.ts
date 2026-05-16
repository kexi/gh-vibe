import { type Stdio, exec } from "../lib/exec.ts";
import { viewPullRequest } from "../lib/gh.ts";
import {
  fetchBranch,
  localBranchExists,
  worktreePathForBranch,
} from "../lib/git.ts";
import { getShellMode } from "../lib/runtime.ts";
import {
  assertSafeShellPath,
  emitShellCommand,
  shellQuote,
} from "../lib/shell.ts";

export interface ReviewOptions {
  prRef: string;
  dryRun: boolean;
}

/**
 * Seams for `reviewCommand` so tests can inject mocks. Defaults wire up the
 * real gh / git / vibe callers plus the real stdout / TTY / env probes.
 */
export interface ReviewDeps {
  viewPullRequest: typeof viewPullRequest;
  fetchBranch: typeof fetchBranch;
  localBranchExists: typeof localBranchExists;
  worktreePathForBranch: typeof worktreePathForBranch;
  exec: typeof exec;
  log: (msg: string) => void;
  /**
   * Emit a single shell command line to stdout. Only ever called from inside
   * the shell-mode branch and only through `emitShellCommand`; see the
   * `emitShellCommand` doc-comment for the stdout discipline.
   */
  writeStdout: (s: string) => void;
  isShellMode: () => boolean;
  isStdoutTty: () => boolean;
}

const defaultDeps: ReviewDeps = {
  viewPullRequest,
  fetchBranch,
  localBranchExists,
  worktreePathForBranch,
  exec,
  log: (msg) => console.error(msg),
  // GRACE NOTE: the *only* `process.stdout.write` call site outside the
  // shell-setup snippet emitter — see `emitShellCommand` below.
  writeStdout: (s) => {
    process.stdout.write(s);
  },
  isShellMode: () => getShellMode(),
  isStdoutTty: () => process.stdout.isTTY === true,
};

export async function reviewCommand(
  opts: ReviewOptions,
  deps: ReviewDeps = defaultDeps,
): Promise<number> {
  const pr = await deps.viewPullRequest(opts.prRef);

  deps.log(`PR #${pr.number}: ${pr.title}`);
  deps.log(`  ${pr.url}`);
  deps.log(
    `  ${pr.headRefName} → ${pr.baseRefName} (${pr.state.toLowerCase()})`,
  );

  // Fork PRs need fetching from the contributor's repo into a local branch
  // namespaced under pr/<number>/<branch> to avoid collisions.
  let localBranch: string;
  if (pr.isCrossRepository) {
    const owner = pr.headRepositoryOwner?.login;
    const repo = pr.headRepository?.name;
    if (!owner || !repo) {
      throw new Error(
        "Cross-repository PR missing fork owner/repo metadata; cannot fetch.",
      );
    }
    localBranch = `pr/${pr.number}/${pr.headRefName}`;
    const forkUrl = `https://github.com/${owner}/${repo}.git`;
    deps.log(`Fetching ${forkUrl} ${pr.headRefName} → ${localBranch}`);
    if (!opts.dryRun) {
      await deps.fetchBranch(forkUrl, `${pr.headRefName}:${localBranch}`);
    }
  } else {
    localBranch = pr.headRefName;
    deps.log(`Fetching origin ${pr.headRefName}`);
    if (!opts.dryRun) {
      await deps.fetchBranch("origin", pr.headRefName);
    }
  }

  // vibe start --reuse requires the branch to already exist locally
  if (!opts.dryRun && !(await deps.localBranchExists(localBranch))) {
    throw new Error(`Expected local branch ${localBranch} after fetch, not found.`);
  }

  deps.log(`Creating worktree via: vibe start ${localBranch} --reuse`);
  if (opts.dryRun) {
    return 0;
  }

  // In shell mode the parent shell will be eval'ing our stdout, so vibe's own
  // stdout must not leak into it. Discard vibe stdout, keep stderr inherited
  // so progress / errors still reach the user.
  const isShellMode = deps.isShellMode();
  const vibeStdio: Stdio = isShellMode
    ? ["inherit", "ignore", "inherit"]
    : "inherit";
  const result = await deps.exec("vibe", ["start", localBranch, "--reuse"], {
    stdio: vibeStdio,
  });
  const isVibeFailed = result.exitCode !== 0;
  if (isVibeFailed) {
    return result.exitCode;
  }

  if (!isShellMode) {
    return 0;
  }

  // Shell mode: hand the parent shell a `cd` to the worktree. Any failure
  // path returns non-zero so the wrapper's `if [ $status -eq 0 ]` guard skips
  // the eval and the user's shell stays put.
  const worktreePath = await deps.worktreePathForBranch(localBranch);
  if (!worktreePath) {
    deps.log(
      `Could not find a worktree for branch '${localBranch}' (cd skipped).`,
    );
    return 1;
  }
  assertSafeShellPath(worktreePath);
  emitShellCommand(deps.writeStdout, `cd ${shellQuote(worktreePath)}`);
  return 0;
}
