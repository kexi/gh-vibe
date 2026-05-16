import { exec, execOrThrow } from "./exec.ts";

export async function fetchBranch(
  remote: string,
  refspec: string,
): Promise<void> {
  await execOrThrow("git", ["fetch", remote, refspec]);
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
