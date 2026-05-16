import { exec } from "../lib/exec.ts";
import { viewPullRequest } from "../lib/gh.ts";
import { fetchBranch, localBranchExists } from "../lib/git.ts";

export interface ReviewOptions {
  prRef: string;
  dryRun: boolean;
}

/**
 * Seams for `reviewCommand` so tests can inject mocks. Defaults wire up the
 * real gh / git / vibe callers.
 */
export interface ReviewDeps {
  viewPullRequest: typeof viewPullRequest;
  fetchBranch: typeof fetchBranch;
  localBranchExists: typeof localBranchExists;
  exec: typeof exec;
  log: (msg: string) => void;
}

const defaultDeps: ReviewDeps = {
  viewPullRequest,
  fetchBranch,
  localBranchExists,
  exec,
  log: (msg) => console.error(msg),
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

  const result = await deps.exec("vibe", ["start", localBranch, "--reuse"], {
    stdio: "inherit",
  });
  return result.exitCode;
}
