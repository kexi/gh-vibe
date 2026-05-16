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
    worktreePathForBranch: async () => "/repos/feature",
    exec: async (): Promise<ExecResult> => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }),
    log: () => {},
    writeStdout: () => {},
    isShellMode: () => false,
    isStdoutTty: () => false,
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

  test("normal mode: writes nothing to stdout", async () => {
    const stdoutChunks: string[] = [];
    const deps = makeDeps({
      isShellMode: () => false,
      writeStdout: (s) => stdoutChunks.push(s),
    });

    await reviewCommand({ prRef: "123", dryRun: false }, deps);

    expect(stdoutChunks).toEqual([]);
  });

  test("normal mode: inherits vibe stdio (no ignore)", async () => {
    const execStdioCalls: Array<unknown> = [];
    const deps = makeDeps({
      isShellMode: () => false,
      exec: async (_cmd, _args, opts) => {
        execStdioCalls.push(opts?.stdio);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await reviewCommand({ prRef: "123", dryRun: false }, deps);

    expect(execStdioCalls).toEqual(["inherit"]);
  });

  test("shell mode: emits sentinel-fenced cd line to stdout", async () => {
    const stdoutChunks: string[] = [];
    const deps = makeDeps({
      isShellMode: () => true,
      worktreePathForBranch: async () => "/repos/feature",
      writeStdout: (s) => stdoutChunks.push(s),
    });

    const code = await reviewCommand({ prRef: "123", dryRun: false }, deps);

    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toBe(
      "# __ghvibe_v1_begin__\ncd '/repos/feature'\n# __ghvibe_v1_end__\n",
    );
  });

  test("shell mode: discards vibe stdout via stdio array", async () => {
    const execStdioCalls: Array<unknown> = [];
    const deps = makeDeps({
      isShellMode: () => true,
      exec: async (_cmd, _args, opts) => {
        execStdioCalls.push(opts?.stdio);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await reviewCommand({ prRef: "123", dryRun: false }, deps);

    expect(execStdioCalls).toEqual([["inherit", "ignore", "inherit"]]);
  });

  test("shell mode: quotes worktree paths containing a single quote", async () => {
    const stdoutChunks: string[] = [];
    const deps = makeDeps({
      isShellMode: () => true,
      worktreePathForBranch: async () => "/repos/wei'rd",
      writeStdout: (s) => stdoutChunks.push(s),
    });

    await reviewCommand({ prRef: "123", dryRun: false }, deps);

    expect(stdoutChunks.join("")).toBe(
      "# __ghvibe_v1_begin__\ncd '/repos/wei'\\''rd'\n# __ghvibe_v1_end__\n",
    );
  });

  test("shell mode: returns non-zero and writes nothing when worktree path is missing", async () => {
    const stdoutChunks: string[] = [];
    const deps = makeDeps({
      isShellMode: () => true,
      worktreePathForBranch: async () => null,
      writeStdout: (s) => stdoutChunks.push(s),
    });

    const code = await reviewCommand({ prRef: "123", dryRun: false }, deps);

    expect(code).not.toBe(0);
    expect(stdoutChunks).toEqual([]);
  });

  test("shell mode: refuses to emit when worktree path contains a newline", async () => {
    const stdoutChunks: string[] = [];
    const deps = makeDeps({
      isShellMode: () => true,
      worktreePathForBranch: async () => "/repos/evil\nrm -rf /",
      writeStdout: (s) => stdoutChunks.push(s),
    });

    await expect(
      reviewCommand({ prRef: "123", dryRun: false }, deps),
    ).rejects.toThrow("control or format characters");
    expect(stdoutChunks).toEqual([]);
  });

  // T-06: NUL, ESC, CR also smuggle commands past `shellQuote`, so they too
  // must short-circuit the emit path and leave stdout untouched.
  test.each([
    ["NUL", "/p\0ath"],
    ["ESC", "/p\x1bath"],
    ["CR", "/p\rath"],
  ])(
    "shell mode: rejects path with %s and writes nothing to stdout",
    async (_label, evilPath) => {
      const stdoutChunks: string[] = [];
      const deps = makeDeps({
        isShellMode: () => true,
        worktreePathForBranch: async () => evilPath,
        writeStdout: (s) => stdoutChunks.push(s),
      });

      await expect(
        reviewCommand({ prRef: "123", dryRun: false }, deps),
      ).rejects.toThrow("control or format characters");
      expect(stdoutChunks).toEqual([]);
    },
  );

  // T-12: viewPullRequest failure must surface unchanged and never touch stdout
  // (the wrapper would otherwise eval whatever leaked through).
  test("shell mode: viewPullRequest throw propagates with stdout untouched", async () => {
    const stdoutChunks: string[] = [];
    const deps = makeDeps({
      isShellMode: () => true,
      viewPullRequest: async () => {
        throw new Error("PR #999 not found.");
      },
      writeStdout: (s) => stdoutChunks.push(s),
    });

    await expect(
      reviewCommand({ prRef: "999", dryRun: false }, deps),
    ).rejects.toThrow("PR #999 not found.");
    expect(stdoutChunks).toEqual([]);
  });

  // T-13: same contract for fetchBranch failures (network / git errors).
  test("shell mode: fetchBranch throw propagates with stdout untouched", async () => {
    const stdoutChunks: string[] = [];
    const deps = makeDeps({
      isShellMode: () => true,
      fetchBranch: async () => {
        throw new Error("git fetch failed");
      },
      writeStdout: (s) => stdoutChunks.push(s),
    });

    await expect(
      reviewCommand({ prRef: "123", dryRun: false }, deps),
    ).rejects.toThrow("git fetch failed");
    expect(stdoutChunks).toEqual([]);
  });

  // T-14: same contract when the worktree path lookup itself throws.
  test("shell mode: worktreePathForBranch throw propagates with stdout untouched", async () => {
    const stdoutChunks: string[] = [];
    const deps = makeDeps({
      isShellMode: () => true,
      worktreePathForBranch: async () => {
        throw new Error("worktree lookup failed");
      },
      writeStdout: (s) => stdoutChunks.push(s),
    });

    await expect(
      reviewCommand({ prRef: "123", dryRun: false }, deps),
    ).rejects.toThrow("worktree lookup failed");
    expect(stdoutChunks).toEqual([]);
  });

  test("shell mode: skips cd emission when vibe fails", async () => {
    const stdoutChunks: string[] = [];
    let worktreeLookups = 0;
    const deps = makeDeps({
      isShellMode: () => true,
      exec: async () => ({ stdout: "", stderr: "", exitCode: 7 }),
      worktreePathForBranch: async () => {
        worktreeLookups += 1;
        return "/repos/feature";
      },
      writeStdout: (s) => stdoutChunks.push(s),
    });

    const code = await reviewCommand({ prRef: "123", dryRun: false }, deps);

    expect(code).toBe(7);
    expect(stdoutChunks).toEqual([]);
    expect(worktreeLookups).toBe(0);
  });
});
