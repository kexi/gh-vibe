import { execOrThrow } from "./exec.ts";

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

export async function viewPullRequest(prRef: string): Promise<PullRequest> {
  const out = await execOrThrow("gh", [
    "pr",
    "view",
    prRef,
    "--json",
    PR_FIELDS,
  ]);
  return JSON.parse(out) as PullRequest;
}
