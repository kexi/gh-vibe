import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../lib/exec.ts";
import type { PullRequest } from "../lib/gh.ts";
import { type ReviewDeps, reviewCommand } from "./review.ts";

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 123,
    title: "Test PR",
    url: "https://github.com/owner/repo/pull/123",
    headRefName: "feature",
    baseRefName: "main",
    isCrossRepository: false,
    headRepository: { name: "repo" },
    headRepositoryOwner: { login: "owner" },
    state: "OPEN",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ReviewDeps> = {}): ReviewDeps {
  return {
    viewPullRequest: async () => makePr(),
    fetchBranch: async () => {},
    localBranchExists: async () => true,
    exec: async (): Promise<ExecResult> => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }),
    log: () => {},
    ...overrides,
  };
}

describe("reviewCommand", () => {
  test("happy path: fetches branch and invokes vibe start --reuse", async () => {
    const fetchCalls: Array<[string, string]> = [];
    const execCalls: Array<[string, string[]]> = [];
    const deps = makeDeps({
      fetchBranch: async (remote, refspec) => {
        fetchCalls.push([remote, refspec]);
      },
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    const code = await reviewCommand({ prRef: "123", dryRun: false }, deps);

    expect(code).toBe(0);
    expect(fetchCalls).toEqual([["origin", "feature"]]);
    expect(execCalls).toEqual([["vibe", ["start", "feature", "--reuse"]]]);
  });

  test("dry-run: skips fetch and vibe exec", async () => {
    let fetchCalled = false;
    let execCalled = false;
    const deps = makeDeps({
      fetchBranch: async () => {
        fetchCalled = true;
      },
      exec: async () => {
        execCalled = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    const code = await reviewCommand({ prRef: "123", dryRun: true }, deps);

    expect(code).toBe(0);
    expect(fetchCalled).toBe(false);
    expect(execCalled).toBe(false);
  });

  test("propagates translated PR-not-found error from viewPullRequest", async () => {
    const deps = makeDeps({
      viewPullRequest: async () => {
        throw new Error("PR #999 not found.");
      },
    });

    await expect(
      reviewCommand({ prRef: "999", dryRun: false }, deps),
    ).rejects.toThrow("PR #999 not found.");
  });

  test("fork PR: namespaces local branch under pr/<n>/<branch>", async () => {
    const fetchCalls: Array<[string, string]> = [];
    const deps = makeDeps({
      viewPullRequest: async () =>
        makePr({
          number: 42,
          headRefName: "feature",
          isCrossRepository: true,
          headRepository: { name: "fork-repo" },
          headRepositoryOwner: { login: "contributor" },
        }),
      fetchBranch: async (remote, refspec) => {
        fetchCalls.push([remote, refspec]);
      },
    });

    await reviewCommand({ prRef: "42", dryRun: false }, deps);

    expect(fetchCalls).toEqual([
      ["https://github.com/contributor/fork-repo.git", "feature:pr/42/feature"],
    ]);
  });

  test("fork PR with missing owner/repo metadata throws", async () => {
    const deps = makeDeps({
      viewPullRequest: async () =>
        makePr({
          isCrossRepository: true,
          headRepository: null,
          headRepositoryOwner: null,
        }),
    });

    await expect(
      reviewCommand({ prRef: "42", dryRun: false }, deps),
    ).rejects.toThrow("Cross-repository PR missing fork");
  });

  test("missing local branch after fetch throws", async () => {
    const deps = makeDeps({
      localBranchExists: async () => false,
    });

    await expect(
      reviewCommand({ prRef: "123", dryRun: false }, deps),
    ).rejects.toThrow("Expected local branch feature after fetch");
  });

  test("returns vibe's exit code on non-zero", async () => {
    const deps = makeDeps({
      exec: async () => ({ stdout: "", stderr: "", exitCode: 3 }),
    });

    const code = await reviewCommand({ prRef: "123", dryRun: false }, deps);
    expect(code).toBe(3);
  });
});
