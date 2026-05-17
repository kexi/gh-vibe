import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../lib/exec.ts";
import type { PullRequest } from "../lib/gh.ts";
import { PrNotFoundError } from "../lib/gh.ts";
import type { WorktreeEntry } from "../lib/git.ts";
import { type CleanDeps, type CleanOptions, cleanCommand } from "./clean.ts";

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 100,
    title: "Test PR",
    url: "https://github.com/owner/repo/pull/100",
    headRefName: "feature",
    baseRefName: "main",
    isCrossRepository: false,
    headRepository: { name: "repo" },
    headRepositoryOwner: { login: "owner" },
    state: "MERGED",
    ...overrides,
  };
}

function makeEntry(overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    path: "/repos/repo-feature",
    branch: "feature",
    isMain: false,
    isBare: false,
    isDetached: false,
    ...overrides,
  };
}

function makeOpts(overrides: Partial<CleanOptions> = {}): CleanOptions {
  return {
    dryRun: false,
    state: new Set<"MERGED" | "CLOSED">(["MERGED", "CLOSED"]),
    includeNoPr: false,
    yes: true,
    allowNoDefaultBranch: false,
    ...overrides,
  };
}

function mainEntry(): WorktreeEntry {
  return {
    path: "/repos/repo",
    branch: "main",
    isMain: true,
    isBare: false,
    isDetached: false,
  };
}

function makeDeps(overrides: Partial<CleanDeps> = {}): CleanDeps {
  return {
    listWorktrees: async () => [mainEntry()],
    getDefaultBranch: async () => "main",
    viewPullRequest: async () => makePr(),
    exec: async (): Promise<ExecResult> => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }),
    log: () => {},
    cwd: () => "/elsewhere",
    isStdoutTty: () => false,
    isShellMode: () => false,
    prompt: async () => "",
    // Default realpath = identity. Tests that exercise symlink-aware
    // comparison override this; everything else gets simple equality.
    realpath: (p: string) => p,
    ...overrides,
  };
}

describe("cleanCommand: discovery / filtering", () => {
  test("no candidates: exits 0 and logs the empty-case message", async () => {
    const logs: string[] = [];
    const deps = makeDeps({ log: (m) => logs.push(m) });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(logs.some((l) => /no vibe-managed worktrees/i.test(l))).toBe(true);
  });

  test("empty worktree list: exit 2 and short-circuits before downstream deps", async () => {
    const logs: string[] = [];
    let defaultBranchCalls = 0;
    let viewPrCalls = 0;
    let execCalls = 0;
    const deps = makeDeps({
      listWorktrees: async () => [],
      getDefaultBranch: async () => {
        defaultBranchCalls += 1;
        return "main";
      },
      viewPullRequest: async () => {
        viewPrCalls += 1;
        return makePr();
      },
      exec: async () => {
        execCalls += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      log: (m) => logs.push(m),
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(2);
    expect(logs.some((l) => l.includes("Could not determine main worktree"))).toBe(
      true,
    );
    expect(defaultBranchCalls).toBe(0);
    expect(viewPrCalls).toBe(0);
    expect(execCalls).toBe(0);
  });

  test("main worktree excluded even when sibling-named", async () => {
    const execCalls: Array<[string, string[]]> = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        // Misleading main path sharing the sibling-prefix shape.
        {
          path: "/repos/repo",
          branch: "main",
          isMain: true,
          isBare: false,
          isDetached: false,
        },
      ],
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(execCalls).toEqual([]);
  });

  test("non-sibling worktrees excluded", async () => {
    const execCalls: Array<[string, string[]]> = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        makeEntry({ path: "/totally/elsewhere/repo-feature" }),
      ],
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(execCalls).toEqual([]);
  });

  test("siblings without the repo-prefix basename excluded", async () => {
    const execCalls: Array<[string, string[]]> = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        makeEntry({ path: "/repos/unrelated-sibling", branch: "x" }),
      ],
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(execCalls).toEqual([]);
  });

  test("detached / bare / branchless entries excluded", async () => {
    const execCalls: Array<[string, string[]]> = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        makeEntry({
          path: "/repos/repo-detached",
          branch: null,
          isDetached: true,
        }),
        makeEntry({
          path: "/repos/repo-bare",
          branch: null,
          isBare: true,
        }),
        makeEntry({ path: "/repos/repo-branchless", branch: null }),
      ],
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(execCalls).toEqual([]);
  });

  test("branch === defaultBranch excluded (defense in depth)", async () => {
    const execCalls: Array<[string, string[]]> = [];
    const viewCalls: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        // A sibling whose branch coincidentally matches the default branch.
        makeEntry({ path: "/repos/repo-main", branch: "main" }),
      ],
      viewPullRequest: async (ref) => {
        viewCalls.push(ref);
        return makePr();
      },
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(execCalls).toEqual([]);
    expect(viewCalls).toEqual([]);
  });

  // Under --allow-no-default-branch, the primary "branch ===
  // defaultBranch" guard short-circuits because defaultBranch is null. A
  // sibling-prefixed worktree on `main` / `master` / `trunk` / `develop`
  // must still be skipped under that conservative fallback, with a logged
  // reason, and never reach the gh call.
  test.each([["main"], ["master"], ["trunk"], ["develop"]])(
    "waiver + sibling on '%s' branch: skipped with warning, no gh call",
    async (likelyDefaultBranch) => {
      const viewCalls: string[] = [];
      const execCalls: Array<[string, string[]]> = [];
      const logs: string[] = [];
      const deps = makeDeps({
        listWorktrees: async () => [
          mainEntry(),
          // Note: NOT isMain, but the branch happens to be a likely default.
          makeEntry({
            path: `/repos/repo-${likelyDefaultBranch}`,
            branch: likelyDefaultBranch,
          }),
        ],
        getDefaultBranch: async () => {
          throw new Error("Could not determine default branch.");
        },
        viewPullRequest: async (ref) => {
          viewCalls.push(ref);
          return makePr();
        },
        exec: async (cmd, args) => {
          execCalls.push([cmd, args]);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        log: (m) => logs.push(m),
      });
      const code = await cleanCommand(
        makeOpts({ allowNoDefaultBranch: true }),
        deps,
      );
      expect(code).toBe(0);
      expect(viewCalls).toEqual([]);
      expect(execCalls).toEqual([]);
      expect(
        logs.some((l) => /likely default branch name/.test(l)),
      ).toBe(true);
    },
  );

  test("defaultBranch failure with --allow-no-default-branch continues + warns", async () => {
    const logs: string[] = [];
    const execCalls: Array<[string, string[]]> = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        makeEntry({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      getDefaultBranch: async () => {
        throw new Error("Could not determine default branch.");
      },
      exec: async (cmd, args, opts) => {
        execCalls.push([cmd, args]);
        expect(opts?.cwd).toBe("/repos/repo-feature");
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      log: (m) => logs.push(m),
    });
    const code = await cleanCommand(
      makeOpts({ allowNoDefaultBranch: true }),
      deps,
    );
    expect(code).toBe(0);
    expect(logs.some((l) => /Warning: could not resolve default branch/.test(l))).toBe(
      true,
    );
    expect(execCalls).toEqual([["vibe", ["clean", "-f", "--delete-branch"]]]);
  });

  test("defaultBranch failure WITHOUT flag: exit 2", async () => {
    const deps = makeDeps({
      getDefaultBranch: async () => {
        throw new Error("Could not determine default branch.");
      },
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(2);
  });

  test("branch failing assertValidRefName (contains ~) skipped, no gh call", async () => {
    const viewCalls: string[] = [];
    const execCalls: Array<[string, string[]]> = [];
    const logs: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        makeEntry({ path: "/repos/repo-bad", branch: "bad~ref" }),
      ],
      viewPullRequest: async (ref) => {
        viewCalls.push(ref);
        return makePr();
      },
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      log: (m) => logs.push(m),
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(viewCalls).toEqual([]);
    expect(execCalls).toEqual([]);
    expect(logs.some((l) => /Skipping.*Invalid ref name/.test(l))).toBe(true);
  });

  test("branch starting with '-' skipped, no gh call", async () => {
    const viewCalls: string[] = [];
    const execCalls: Array<[string, string[]]> = [];
    const logs: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        makeEntry({ path: "/repos/repo--evil", branch: "-evil" }),
      ],
      viewPullRequest: async (ref) => {
        viewCalls.push(ref);
        return makePr();
      },
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      log: (m) => logs.push(m),
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(viewCalls).toEqual([]);
    expect(execCalls).toEqual([]);
    expect(logs.some((l) => /Skipping.*starts with '-'/.test(l))).toBe(true);
  });
});

describe("cleanCommand: classification", () => {
  function siblingDeps(
    pr: PullRequest | (() => Promise<PullRequest>),
    extra: Partial<CleanDeps> = {},
  ): CleanDeps {
    return makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        makeEntry({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      viewPullRequest:
        typeof pr === "function"
          ? pr
          : async () => pr,
      ...extra,
    });
  }

  test("merged PR + default state: delete", async () => {
    const execCalls: Array<[string, string[], unknown]> = [];
    const deps = siblingDeps(makePr({ state: "MERGED" }), {
      exec: async (cmd, args, opts) => {
        execCalls.push([cmd, args, opts?.cwd]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(execCalls).toEqual([
      ["vibe", ["clean", "-f", "--delete-branch"], "/repos/repo-feature"],
    ]);
  });

  test("closed PR + default state: delete", async () => {
    const execCalls: Array<[string, string[]]> = [];
    const deps = siblingDeps(makePr({ state: "CLOSED" }), {
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(execCalls).toEqual([["vibe", ["clean", "-f", "--delete-branch"]]]);
  });

  test("merged PR + --state=closed: skip (state)", async () => {
    const execCalls: Array<[string, string[]]> = [];
    const deps = siblingDeps(makePr({ state: "MERGED" }), {
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(
      makeOpts({ state: new Set(["CLOSED"]) }),
      deps,
    );
    expect(code).toBe(0);
    expect(execCalls).toEqual([]);
  });

  test("closed PR + --state=merged: skip (state)", async () => {
    const execCalls: Array<[string, string[]]> = [];
    const deps = siblingDeps(makePr({ state: "CLOSED" }), {
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(
      makeOpts({ state: new Set(["MERGED"]) }),
      deps,
    );
    expect(code).toBe(0);
    expect(execCalls).toEqual([]);
  });

  test("PrNotFoundError + default !includeNoPr: skip (no-pr)", async () => {
    const execCalls: Array<[string, string[]]> = [];
    const deps = siblingDeps(
      async () => {
        throw new PrNotFoundError("PR not found.");
      },
      {
        exec: async (cmd, args) => {
          execCalls.push([cmd, args]);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
    );
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(execCalls).toEqual([]);
  });

  test("PrNotFoundError + --include-no-pr: delete", async () => {
    const execCalls: Array<[string, string[], unknown]> = [];
    const deps = siblingDeps(
      async () => {
        throw new PrNotFoundError("PR not found.");
      },
      {
        exec: async (cmd, args, opts) => {
          execCalls.push([cmd, args, opts?.cwd]);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
    );
    const code = await cleanCommand(
      makeOpts({ includeNoPr: true }),
      deps,
    );
    expect(code).toBe(0);
    expect(execCalls).toEqual([
      ["vibe", ["clean", "-f", "--delete-branch"], "/repos/repo-feature"],
    ]);
  });

  test("generic Error from viewPullRequest: skip + transient failure, exit 1", async () => {
    const execCalls: Array<[string, string[]]> = [];
    const deps = siblingDeps(
      async () => {
        throw new Error("network blew up");
      },
      {
        exec: async (cmd, args) => {
          execCalls.push([cmd, args]);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
    );
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(1);
    expect(execCalls).toEqual([]);
  });

  test("cwd === candidate.path: skip (is-cwd), no gh call", async () => {
    const viewCalls: string[] = [];
    const execCalls: Array<[string, string[]]> = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        makeEntry({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      cwd: () => "/repos/repo-feature",
      viewPullRequest: async (ref) => {
        viewCalls.push(ref);
        return makePr();
      },
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(viewCalls).toEqual([]);
    expect(execCalls).toEqual([]);
  });

  // Critical: symlink-resolved cwd (`/private/repos/repo-feature` from macOS
  // realpath) and the worktree entry path (`/repos/repo-feature` reported by
  // `git worktree list` after its own realpath) must still classify as the
  // SAME directory. Otherwise a user sitting inside the candidate worktree
  // could see it deleted out from under them because the string compare
  // failed to recognise the symlink-aliased pair.
  test("symlink-aliased cwd === candidate.path: skip (is-cwd), no gh call", async () => {
    const viewCalls: string[] = [];
    const execCalls: Array<[string, string[]]> = [];
    const realpathCalls: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        makeEntry({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      cwd: () => "/private/repos/repo-feature",
      realpath: (p) => {
        realpathCalls.push(p);
        // Map both the cwd form and the entry form to a single canonical
        // path. This is what `fs.realpathSync` does on macOS where `/var`
        // and `/repos` (when symlinked to `/private/...`) collapse.
        if (
          p === "/private/repos/repo-feature" ||
          p === "/repos/repo-feature"
        ) {
          return "/canonical/repos/repo-feature";
        }
        return p;
      },
      viewPullRequest: async (ref) => {
        viewCalls.push(ref);
        return makePr();
      },
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(viewCalls).toEqual([]);
    expect(execCalls).toEqual([]);
    // Sanity: helper must have probed both sides.
    expect(realpathCalls).toContain("/private/repos/repo-feature");
    expect(realpathCalls).toContain("/repos/repo-feature");
  });

  // If realpath throws (path doesn't exist, EACCES, …) we MUST NOT silently
  // open a deletion path. Fall back to raw string compare and log a warning.
  test("realpath throws: falls back to raw string equality with warning", async () => {
    const logs: string[] = [];
    const execCalls: Array<[string, string[]]> = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        makeEntry({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      // cwd matches entry.path verbatim so the raw-string fallback still
      // correctly classifies "is-cwd" and skips the delete.
      cwd: () => "/repos/repo-feature",
      realpath: () => {
        throw new Error("ENOENT: no such file or directory");
      },
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      log: (m) => logs.push(m),
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(execCalls).toEqual([]);
    expect(logs.some((l) => /realpath failed/.test(l))).toBe(true);
  });
});

describe("cleanCommand: execution", () => {
  test("dry-run: no exec calls, lists candidates", async () => {
    const execCalls: Array<[string, string[]]> = [];
    const logs: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        makeEntry({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      log: (m) => logs.push(m),
    });
    const code = await cleanCommand(makeOpts({ dryRun: true }), deps);
    expect(code).toBe(0);
    expect(execCalls).toEqual([]);
    expect(logs.some((l) => /^delete\b/.test(l))).toBe(true);
    expect(logs.some((l) => /^Dry run/.test(l))).toBe(true);
  });

  test("happy path single delete: cwd=candidate.path, args verbatim", async () => {
    const execCalls: Array<{ cmd: string; args: string[]; cwd: unknown }> = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        makeEntry({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      exec: async (cmd, args, opts) => {
        execCalls.push({ cmd, args, cwd: opts?.cwd });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(execCalls).toEqual([
      {
        cmd: "vibe",
        args: ["clean", "-f", "--delete-branch"],
        cwd: "/repos/repo-feature",
      },
    ]);
  });

  test("multiple deletes: every exec has the canonical args + a candidate cwd", async () => {
    const execCalls: Array<{ cmd: string; args: string[]; cwd: unknown }> = [];
    const paths = ["/repos/repo-a", "/repos/repo-b", "/repos/repo-c"];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        ...paths.map((p, i) =>
          makeEntry({ path: p, branch: `feature-${i}` }),
        ),
      ],
      exec: async (cmd, args, opts) => {
        execCalls.push({ cmd, args, cwd: opts?.cwd });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(execCalls.length).toBe(paths.length);
    for (const call of execCalls) {
      expect(call.cmd).toBe("vibe");
      expect(call.args).toEqual(["clean", "-f", "--delete-branch"]);
      expect(paths).toContain(call.cwd as string);
    }
  });

  test("vibe non-zero on one candidate: subsequent processed, exit 1", async () => {
    const execCalls: Array<unknown> = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        makeEntry({ path: "/repos/repo-a", branch: "feature-a" }),
        makeEntry({ path: "/repos/repo-b", branch: "feature-b" }),
      ],
      exec: async (_cmd, _args, opts) => {
        execCalls.push(opts?.cwd);
        const isFirst = opts?.cwd === "/repos/repo-a";
        return {
          stdout: "",
          stderr: "",
          exitCode: isFirst ? 9 : 0,
        };
      },
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(1);
    expect(execCalls).toEqual(["/repos/repo-a", "/repos/repo-b"]);
  });

  test("transient gh + delete failure both contribute to failure count", async () => {
    const logs: string[] = [];
    let prCalls = 0;
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        makeEntry({ path: "/repos/repo-a", branch: "feature-a" }),
        makeEntry({ path: "/repos/repo-b", branch: "feature-b" }),
      ],
      viewPullRequest: async () => {
        prCalls += 1;
        if (prCalls === 1) {
          throw new Error("transient gh failure");
        }
        return makePr({ state: "MERGED" });
      },
      exec: async () => ({ stdout: "", stderr: "", exitCode: 7 }),
      log: (m) => logs.push(m),
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(1);
    expect(
      logs.some((l) => /Removed 0, skipped 1, failed 2\./.test(l)),
    ).toBe(true);
  });
});

describe("cleanCommand: shell-mode + non-TTY refusal", () => {
  test("isShellMode=true: exit 2, no enumerate/gh/exec calls", async () => {
    let listed = false;
    let viewed = false;
    let execd = false;
    const deps = makeDeps({
      isShellMode: () => true,
      listWorktrees: async () => {
        listed = true;
        return [mainEntry()];
      },
      viewPullRequest: async () => {
        viewed = true;
        return makePr();
      },
      exec: async () => {
        execd = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(2);
    expect(listed).toBe(false);
    expect(viewed).toBe(false);
    expect(execd).toBe(false);
  });

  test("non-TTY without --yes: exit 2, no exec calls", async () => {
    const execCalls: Array<unknown> = [];
    const deps = makeDeps({
      isStdoutTty: () => false,
      exec: async () => {
        execCalls.push(true);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts({ yes: false }), deps);
    expect(code).toBe(2);
    expect(execCalls).toEqual([]);
  });

  test("non-TTY with --yes: proceeds (CI path)", async () => {
    const execCalls: Array<unknown> = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        makeEntry({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      isStdoutTty: () => false,
      exec: async (_cmd, _args, opts) => {
        execCalls.push(opts?.cwd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts({ yes: true }), deps);
    expect(code).toBe(0);
    expect(execCalls).toEqual(["/repos/repo-feature"]);
  });
});

describe("cleanCommand: confirmation prompt", () => {
  function depsWithCandidates(
    count: number,
    overrides: Partial<CleanDeps> = {},
  ): CleanDeps {
    const entries: WorktreeEntry[] = [mainEntry()];
    for (let i = 0; i < count; i++) {
      entries.push(
        makeEntry({ path: `/repos/repo-x${i}`, branch: `feature-${i}` }),
      );
    }
    return makeDeps({
      listWorktrees: async () => entries,
      isStdoutTty: () => true,
      ...overrides,
    });
  }

  test("TTY + !yes + !dry-run + 3 deletes + input '3' → proceeds", async () => {
    const promptCalls: string[] = [];
    const execCalls: Array<unknown> = [];
    const deps = depsWithCandidates(3, {
      prompt: async (msg) => {
        promptCalls.push(msg);
        return "3";
      },
      exec: async (_cmd, _args, opts) => {
        execCalls.push(opts?.cwd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts({ yes: false }), deps);
    expect(code).toBe(0);
    expect(promptCalls.length).toBe(1);
    expect(promptCalls[0]).toMatch(/Type 3 to confirm/);
    expect(execCalls.length).toBe(3);
  });

  test.each([
    ["yes", "yes"],
    ["wrong-number", "2"],
    ["empty", ""],
  ])("input %s aborts with exit 0 and no exec calls", async (_label, answer) => {
    const execCalls: Array<unknown> = [];
    const deps = depsWithCandidates(3, {
      prompt: async () => answer,
      exec: async () => {
        execCalls.push(true);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts({ yes: false }), deps);
    expect(code).toBe(0);
    expect(execCalls).toEqual([]);
  });

  test("planned-delete count 0: prompt NOT called even in TTY", async () => {
    const promptCalls: string[] = [];
    const deps = makeDeps({
      // No siblings at all → 0 deletions.
      listWorktrees: async () => [mainEntry()],
      isStdoutTty: () => true,
      prompt: async (m) => {
        promptCalls.push(m);
        return "";
      },
    });
    const code = await cleanCommand(makeOpts({ yes: false }), deps);
    expect(code).toBe(0);
    expect(promptCalls).toEqual([]);
  });

  test("dry-run skips prompt entirely", async () => {
    const promptCalls: string[] = [];
    const deps = depsWithCandidates(2, {
      prompt: async (m) => {
        promptCalls.push(m);
        return "2";
      },
    });
    const code = await cleanCommand(
      makeOpts({ yes: false, dryRun: true }),
      deps,
    );
    expect(code).toBe(0);
    expect(promptCalls).toEqual([]);
  });

  test("--yes skips prompt", async () => {
    const promptCalls: string[] = [];
    const execCalls: Array<unknown> = [];
    const deps = depsWithCandidates(2, {
      prompt: async (m) => {
        promptCalls.push(m);
        return "";
      },
      exec: async (_cmd, _args, opts) => {
        execCalls.push(opts?.cwd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts({ yes: true }), deps);
    expect(code).toBe(0);
    expect(promptCalls).toEqual([]);
    expect(execCalls.length).toBe(2);
  });

  // Pin the prompt grammar at N=1. The string is user-visible UX; we
  // want a refactor that accidentally changes "1 worktree(s)" to break the
  // build so the change is intentional.
  test("N=1 candidate, prompt input '1': prompt grammar is exact", async () => {
    const promptCalls: string[] = [];
    const execCalls: Array<unknown> = [];
    const deps = depsWithCandidates(1, {
      prompt: async (m) => {
        promptCalls.push(m);
        return "1";
      },
      exec: async (_cmd, _args, opts) => {
        execCalls.push(opts?.cwd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts({ yes: false }), deps);
    expect(code).toBe(0);
    expect(promptCalls).toEqual([
      "Type 1 to confirm deletion of 1 worktree(s): ",
    ]);
    expect(execCalls.length).toBe(1);
  });

  // Simulating Ctrl-C inside readline — the injected prompt rejects
  // with an Error. Contract: cleanCommand SWALLOWS the rejection, logs an
  // "Aborted (prompt error: …)" line, returns exit 0, and never reaches an
  // exec call. Pins the safer "no deletes on prompt failure" behavior.
  test("prompt rejection (Ctrl-C): returns 0, no exec, logs abort", async () => {
    const execCalls: Array<unknown> = [];
    const logs: string[] = [];
    const deps = depsWithCandidates(3, {
      prompt: async () => {
        throw new Error("readline EOF");
      },
      exec: async () => {
        execCalls.push(true);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      log: (m) => logs.push(m),
    });
    const code = await cleanCommand(makeOpts({ yes: false }), deps);
    expect(code).toBe(0);
    expect(execCalls).toEqual([]);
    expect(logs.some((l) => /Aborted \(prompt error:/.test(l))).toBe(true);
  });
});

describe("cleanCommand: security / log discipline", () => {
  test("path with spaces is passed to exec as cwd verbatim", async () => {
    const execCalls: Array<unknown> = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        {
          path: "/repos/my repo",
          branch: "main",
          isMain: true,
          isBare: false,
          isDetached: false,
        },
        makeEntry({
          path: "/repos/my repo-feature",
          branch: "feature",
        }),
      ],
      exec: async (_cmd, _args, opts) => {
        execCalls.push(opts?.cwd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(execCalls).toEqual(["/repos/my repo-feature"]);
  });

  test("ANSI escape in path: log lines sanitized, exec cwd intact", async () => {
    const logs: string[] = [];
    const execCalls: Array<unknown> = [];
    const evilPath = "/repos/repo-\x1b[2Jevil";
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        makeEntry({ path: evilPath, branch: "feature" }),
      ],
      exec: async (_cmd, _args, opts) => {
        execCalls.push(opts?.cwd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      log: (m) => logs.push(m),
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(execCalls).toEqual([evilPath]);
    for (const line of logs) {
      expect(line).not.toContain("\x1b");
    }
  });

  test("U+202E in path: log lines sanitized, exec cwd intact", async () => {
    const logs: string[] = [];
    const execCalls: Array<unknown> = [];
    const evilPath = "/repos/repo-‮evil";
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        makeEntry({ path: evilPath, branch: "feature" }),
      ],
      exec: async (_cmd, _args, opts) => {
        execCalls.push(opts?.cwd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      log: (m) => logs.push(m),
    });
    const code = await cleanCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(execCalls).toEqual([evilPath]);
    for (const line of logs) {
      expect(line).not.toContain("‮");
    }
  });
});
