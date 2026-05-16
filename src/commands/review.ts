import { exec } from "../lib/exec.ts";
import { viewPullRequest } from "../lib/gh.ts";
import { fetchBranch, localBranchExists } from "../lib/git.ts";

export interface ReviewOptions {
  prRef: string;
  dryRun: boolean;
}

export async function reviewCommand(opts: ReviewOptions): Promise<number> {
  const pr = await viewPullRequest(opts.prRef);

  console.error(`PR #${pr.number}: ${pr.title}`);
  console.error(`  ${pr.url}`);
  console.error(
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
    console.error(`Fetching ${forkUrl} ${pr.headRefName} → ${localBranch}`);
    if (!opts.dryRun) {
      await fetchBranch(forkUrl, `${pr.headRefName}:${localBranch}`);
    }
  } else {
    localBranch = pr.headRefName;
    console.error(`Fetching origin ${pr.headRefName}`);
    if (!opts.dryRun) {
      await fetchBranch("origin", pr.headRefName);
    }
  }

  // vibe start --reuse requires the branch to already exist locally
  if (!opts.dryRun && !(await localBranchExists(localBranch))) {
    throw new Error(`Expected local branch ${localBranch} after fetch, not found.`);
  }

  console.error(`Creating worktree via: vibe start ${localBranch} --reuse`);
  if (opts.dryRun) {
    return 0;
  }

  const result = await exec("vibe", ["start", localBranch, "--reuse"], {
    stdio: "inherit",
  });
  return result.exitCode;
}
