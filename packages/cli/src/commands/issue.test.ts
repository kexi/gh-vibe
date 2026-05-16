import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../lib/exec.ts";
import type { Issue } from "../lib/gh.ts";
import { type IssueDeps, issueCommand } from "./issue.ts";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 5,
    title: "Fix the login bug",
    url: "https://github.com/owner/repo/issues/5",
    state: "OPEN",
    labels: [{ name: "bug" }],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<IssueDeps> = {}): IssueDeps {
  return {
    viewIssue: async () => makeIssue(),
    getDefaultBranch: async () => "main",
    assertValidRefName: () => {},
    fetchBranch: async () => {},
    localBranchExists: async () => false,
    worktreePathForBranch: async () => "/repos/issue-5",
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

describe("issueCommand", () => {
  test("happy path: invokes vibe start <branch> --base main and fetches origin main", async () => {
    const fetchCalls: Array<[string, string]> = [];
    const execCalls: Array<[string, string[]]> = [];
    const stdioCalls: Array<unknown> = [];
    const deps = makeDeps({
      fetchBranch: async (remote, refspec) => {
        fetchCalls.push([remote, refspec]);
      },
      exec: async (cmd, args, opts) => {
        execCalls.push([cmd, args]);
        stdioCalls.push(opts?.stdio);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    const code = await issueCommand(
      { issueRef: "5", dryRun: false },
      deps,
    );

    expect(code).toBe(0);
    expect(fetchCalls).toEqual([["origin", "main"]]);
    expect(execCalls).toEqual([
      ["vibe", ["start", "fix/5-fix-the-login-bug", "--base", "main"]],
    ]);
    expect(stdioCalls).toEqual(["inherit"]);
  });

  test("--base develop skips getDefaultBranch and is forwarded to vibe", async () => {
    let getDefaultCalls = 0;
    const execCalls: Array<[string, string[]]> = [];
    const deps = makeDeps({
      getDefaultBranch: async () => {
        getDefaultCalls += 1;
        return "main";
      },
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    const code = await issueCommand(
      { issueRef: "5", dryRun: false, base: "develop" },
      deps,
    );

    expect(code).toBe(0);
    expect(getDefaultCalls).toBe(0);
    expect(execCalls).toEqual([
      [
        "vibe",
        ["start", "fix/5-fix-the-login-bug", "--base", "develop"],
      ],
    ]);
  });

  test("--type feat overrides labels and produces feat/<n>-<slug>", async () => {
    const execCalls: Array<[string, string[]]> = [];
    const deps = makeDeps({
      viewIssue: async () =>
        makeIssue({
          number: 9,
          title: "Add cache",
          labels: [{ name: "bug" }],
        }),
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await issueCommand(
      { issueRef: "9", dryRun: false, type: "feat" },
      deps,
    );

    expect(execCalls).toEqual([
      ["vibe", ["start", "feat/9-add-cache", "--base", "main"]],
    ]);
  });

  test("empty labels fall back to chore/<n>-<slug>", async () => {
    const execCalls: Array<[string, string[]]> = [];
    const deps = makeDeps({
      viewIssue: async () =>
        makeIssue({ number: 3, title: "Tidy logs", labels: [] }),
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await issueCommand({ issueRef: "3", dryRun: false }, deps);

    expect(execCalls).toEqual([
      ["vibe", ["start", "chore/3-tidy-logs", "--base", "main"]],
    ]);
  });

  test("dry-run: returns 0, queries gh + git, skips fetch and exec", async () => {
    let fetchCalled = false;
    let execCalled = false;
    let viewIssueCalled = false;
    let getDefaultBranchCalled = false;
    let localBranchExistsCalled = false;
    const deps = makeDeps({
      viewIssue: async () => {
        viewIssueCalled = true;
        return makeIssue();
      },
      getDefaultBranch: async () => {
        getDefaultBranchCalled = true;
        return "main";
      },
      localBranchExists: async () => {
        localBranchExistsCalled = true;
        return false;
      },
      fetchBranch: async () => {
        fetchCalled = true;
      },
      exec: async () => {
        execCalled = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    const code = await issueCommand(
      { issueRef: "5", dryRun: true },
      deps,
    );

    expect(code).toBe(0);
    expect(viewIssueCalled).toBe(true);
    expect(getDefaultBranchCalled).toBe(true);
    expect(localBranchExistsCalled).toBe(true);
    expect(fetchCalled).toBe(false);
    expect(execCalled).toBe(false);
  });

  test("dry-run still surfaces local-branch collision", async () => {
    const deps = makeDeps({
      localBranchExists: async () => true,
    });

    await expect(
      issueCommand({ issueRef: "5", dryRun: true }, deps),
    ).rejects.toThrow(/already exists/);
  });

  test("dry-run does NOT emit shell sentinel even in shell mode", async () => {
    const stdoutChunks: string[] = [];
    const deps = makeDeps({
      isShellMode: () => true,
      writeStdout: (s) => stdoutChunks.push(s),
    });

    const code = await issueCommand(
      { issueRef: "5", dryRun: true },
      deps,
    );

    expect(code).toBe(0);
    expect(stdoutChunks).toEqual([]);
  });

  test("propagates translated 'Issue #N not found' from viewIssue", async () => {
    const deps = makeDeps({
      viewIssue: async () => {
        throw new Error("Issue #999 not found.");
      },
    });

    await expect(
      issueCommand({ issueRef: "999", dryRun: false }, deps),
    ).rejects.toThrow("Issue #999 not found.");
  });

  test("local branch collision: friendly error, no fetch / exec, stdout untouched", async () => {
    let fetchCalled = false;
    let execCalled = false;
    const stdoutChunks: string[] = [];
    const deps = makeDeps({
      localBranchExists: async () => true,
      fetchBranch: async () => {
        fetchCalled = true;
      },
      exec: async () => {
        execCalled = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      writeStdout: (s) => stdoutChunks.push(s),
    });

    await expect(
      issueCommand({ issueRef: "5", dryRun: false }, deps),
    ).rejects.toThrow("already exists");
    expect(fetchCalled).toBe(false);
    expect(execCalled).toBe(false);
    expect(stdoutChunks).toEqual([]);
  });

  test("getDefaultBranch failure propagates with stdout untouched", async () => {
    const stdoutChunks: string[] = [];
    const deps = makeDeps({
      getDefaultBranch: async () => {
        throw new Error("Could not determine default branch.");
      },
      writeStdout: (s) => stdoutChunks.push(s),
    });

    await expect(
      issueCommand({ issueRef: "5", dryRun: false }, deps),
    ).rejects.toThrow("Could not determine default branch.");
    expect(stdoutChunks).toEqual([]);
  });

  test("--base failing assertValidRefName bubbles 'Invalid ref name'", async () => {
    const deps = makeDeps({
      assertValidRefName: (name) => {
        throw new Error(`Invalid ref name: ${name}`);
      },
    });

    await expect(
      issueCommand(
        { issueRef: "5", dryRun: false, base: "weird ref" },
        deps,
      ),
    ).rejects.toThrow("Invalid ref name: weird ref");
  });

  test("vibe start exit code 7 → returns 7", async () => {
    const deps = makeDeps({
      exec: async () => ({ stdout: "", stderr: "", exitCode: 7 }),
    });

    const code = await issueCommand(
      { issueRef: "5", dryRun: false },
      deps,
    );

    expect(code).toBe(7);
  });

  test("normal mode: writes nothing to stdout", async () => {
    const stdoutChunks: string[] = [];
    const deps = makeDeps({
      isShellMode: () => false,
      writeStdout: (s) => stdoutChunks.push(s),
    });

    await issueCommand({ issueRef: "5", dryRun: false }, deps);

    expect(stdoutChunks).toEqual([]);
  });

  test("shell mode: emits sentinel-fenced cd line to stdout", async () => {
    const stdoutChunks: string[] = [];
    const deps = makeDeps({
      isShellMode: () => true,
      worktreePathForBranch: async () => "/repos/issue-5",
      writeStdout: (s) => stdoutChunks.push(s),
    });

    const code = await issueCommand(
      { issueRef: "5", dryRun: false },
      deps,
    );

    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toBe(
      "# __ghvibe_v1_begin__\ncd '/repos/issue-5'\n# __ghvibe_v1_end__\n",
    );
  });

  test("shell mode: passes ['inherit','ignore','inherit'] stdio to vibe", async () => {
    const stdioCalls: Array<unknown> = [];
    const deps = makeDeps({
      isShellMode: () => true,
      exec: async (_cmd, _args, opts) => {
        stdioCalls.push(opts?.stdio);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await issueCommand({ issueRef: "5", dryRun: false }, deps);

    expect(stdioCalls).toEqual([["inherit", "ignore", "inherit"]]);
  });

  test("shell mode: skips emit when vibe fails (passthrough exit + stdout untouched)", async () => {
    const stdoutChunks: string[] = [];
    let worktreeLookups = 0;
    const deps = makeDeps({
      isShellMode: () => true,
      exec: async () => ({ stdout: "", stderr: "", exitCode: 7 }),
      worktreePathForBranch: async () => {
        worktreeLookups += 1;
        return "/repos/issue-5";
      },
      writeStdout: (s) => stdoutChunks.push(s),
    });

    const code = await issueCommand(
      { issueRef: "5", dryRun: false },
      deps,
    );

    expect(code).toBe(7);
    expect(stdoutChunks).toEqual([]);
    expect(worktreeLookups).toBe(0);
  });

  test("shell mode: returns 1 with stdout untouched when worktreePathForBranch returns null", async () => {
    const stdoutChunks: string[] = [];
    const deps = makeDeps({
      isShellMode: () => true,
      worktreePathForBranch: async () => null,
      writeStdout: (s) => stdoutChunks.push(s),
    });

    const code = await issueCommand(
      { issueRef: "5", dryRun: false },
      deps,
    );

    expect(code).toBe(1);
    expect(stdoutChunks).toEqual([]);
  });

  test("shell mode: rejects worktree path containing RLO (U+202E)", async () => {
    const stdoutChunks: string[] = [];
    const deps = makeDeps({
      isShellMode: () => true,
      worktreePathForBranch: async () => "/repos/‮evil",
      writeStdout: (s) => stdoutChunks.push(s),
    });

    await expect(
      issueCommand({ issueRef: "5", dryRun: false }, deps),
    ).rejects.toThrow("control or format characters");
    expect(stdoutChunks).toEqual([]);
  });

  test("Unicode-only title falls back to issue-<n>; vibe is invoked with that branch", async () => {
    const execCalls: Array<[string, string[]]> = [];
    const deps = makeDeps({
      viewIssue: async () =>
        makeIssue({
          number: 11,
          title: "日本語と絵文字🎉のみ",
          labels: [],
        }),
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await issueCommand({ issueRef: "11", dryRun: false }, deps);

    expect(execCalls).toEqual([
      ["vibe", ["start", "chore/11-issue-11", "--base", "main"]],
    ]);
  });

  test("viewIssue throw propagates with stdout untouched", async () => {
    const stdoutChunks: string[] = [];
    const deps = makeDeps({
      isShellMode: () => true,
      viewIssue: async () => {
        throw new Error("Issue #999 not found.");
      },
      writeStdout: (s) => stdoutChunks.push(s),
    });

    await expect(
      issueCommand({ issueRef: "999", dryRun: false }, deps),
    ).rejects.toThrow("Issue #999 not found.");
    expect(stdoutChunks).toEqual([]);
  });

  test("fetchBranch throw propagates with stdout untouched", async () => {
    const stdoutChunks: string[] = [];
    const deps = makeDeps({
      isShellMode: () => true,
      fetchBranch: async () => {
        throw new Error("git fetch failed");
      },
      writeStdout: (s) => stdoutChunks.push(s),
    });

    await expect(
      issueCommand({ issueRef: "5", dryRun: false }, deps),
    ).rejects.toThrow("git fetch failed");
    expect(stdoutChunks).toEqual([]);
  });

  test("worktreePathForBranch throw propagates with stdout untouched", async () => {
    const stdoutChunks: string[] = [];
    const deps = makeDeps({
      isShellMode: () => true,
      worktreePathForBranch: async () => {
        throw new Error("worktree lookup failed");
      },
      writeStdout: (s) => stdoutChunks.push(s),
    });

    await expect(
      issueCommand({ issueRef: "5", dryRun: false }, deps),
    ).rejects.toThrow("worktree lookup failed");
    expect(stdoutChunks).toEqual([]);
  });

  // R3: defense-in-depth — `main.ts` already rejects `--base -foo` at the
  // argv boundary, but `issueCommand` re-checks for library callers. Cover the
  // library-level path so future refactors don't silently drop it.
  test("library-level: base starting with '-' is rejected even when main.ts is bypassed", async () => {
    const deps = makeDeps();

    await expect(
      issueCommand({ issueRef: "5", dryRun: true, base: "-foo" }, deps),
    ).rejects.toThrow(/Refusing base ref starting with '-'.*-foo/);
  });

  // R4: URL-form issueRef must flow through verbatim to `viewIssue` — gh
  // accepts both number and URL forms, and we intentionally do not parse or
  // validate the URL ourselves.
  test("URL-form issueRef is forwarded verbatim to viewIssue", async () => {
    const viewIssueCalls: string[] = [];
    const url = "https://github.com/owner/repo/issues/42";
    const deps = makeDeps({
      viewIssue: async (ref) => {
        viewIssueCalls.push(ref);
        return makeIssue({ number: 42 });
      },
    });

    const code = await issueCommand(
      { issueRef: url, dryRun: true },
      deps,
    );

    expect(code).toBe(0);
    expect(viewIssueCalls).toEqual([url]);
  });

  // R5: regression guard — `assertValidRefName` must be called on the resolved
  // base *before* `viewIssue`. Reordering would let a malformed --base value
  // reach gh / git callers before validation; this test pins the order.
  test("assertValidRefName runs on resolved base before viewIssue", async () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      getDefaultBranch: async () => {
        callOrder.push("getDefaultBranch");
        return "main";
      },
      assertValidRefName: (name) => {
        callOrder.push(`assertValidRefName:${name}`);
      },
      viewIssue: async () => {
        callOrder.push("viewIssue");
        return makeIssue();
      },
    });

    await issueCommand({ issueRef: "5", dryRun: true }, deps);

    const assertIdx = callOrder.indexOf("assertValidRefName:main");
    const viewIdx = callOrder.indexOf("viewIssue");
    expect(assertIdx).toBeGreaterThanOrEqual(0);
    expect(viewIdx).toBeGreaterThanOrEqual(0);
    expect(assertIdx).toBeLessThan(viewIdx);
  });
});
