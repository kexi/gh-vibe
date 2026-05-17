import { describe, expect, test } from "bun:test";
import type { PullRequestSummary } from "../lib/gh.ts";
import type { WorktreeEntry } from "../lib/git.ts";
import {
  type ListDeps,
  type ListOptions,
  listCommand,
} from "./list.ts";

function mainEntry(): WorktreeEntry {
  return {
    path: "/repos/repo",
    branch: "main",
    isMain: true,
    isBare: false,
    isDetached: false,
  };
}

function sibling(overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    path: "/repos/repo-feature",
    branch: "feature",
    isMain: false,
    isBare: false,
    isDetached: false,
    ...overrides,
  };
}

function makePr(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 100,
    headRefName: "feature",
    state: "OPEN",
    mergeable: "MERGEABLE",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    reviewDecision: "APPROVED",
    ...overrides,
  };
}

function makeOpts(overrides: Partial<ListOptions> = {}): ListOptions {
  return {
    json: false,
    stale: false,
    limit: 200,
    allowNoDefaultBranch: false,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ListDeps> = {}): ListDeps {
  return {
    listWorktrees: async () => [mainEntry()],
    getDefaultBranch: async () => "main",
    listPullRequests: async () => [],
    log: () => {},
    writeStdout: () => {},
    isShellMode: () => false,
    ...overrides,
  };
}

describe("listCommand: shell-mode refusal", () => {
  test("isShellMode=true: exit 2 BEFORE any I/O (no listWorktrees / no listPullRequests)", async () => {
    let listed = false;
    let prsCalled = false;
    const deps = makeDeps({
      isShellMode: () => true,
      listWorktrees: async () => {
        listed = true;
        return [mainEntry()];
      },
      listPullRequests: async () => {
        prsCalled = true;
        return [];
      },
    });
    const code = await listCommand(makeOpts(), deps);
    expect(code).toBe(2);
    expect(listed).toBe(false);
    expect(prsCalled).toBe(false);
  });
});

describe("listCommand: plain-text output", () => {
  test("orphan worktree (no PR) renders with '-' columns and isStale=false", async () => {
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-orphan", branch: "orphan" }),
      ],
      listPullRequests: async () => [],
      writeStdout: (s) => out.push(s),
    });
    const code = await listCommand(makeOpts(), deps);
    expect(code).toBe(0);
    const full = out.join("");
    expect(full).toContain("PATH");
    expect(full).toContain("/repos/repo-orphan");
    expect(full).toMatch(/orphan\s+-\s+-\s+none\s+-\s+no/);
    expect(full.endsWith("\n")).toBe(true);
  });

  test("matched PR fills PR, STATE, CI, REVIEW columns", async () => {
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      listPullRequests: async () =>
        [
          makePr({ number: 42, headRefName: "feature", state: "OPEN" }),
        ] as PullRequestSummary[],
      writeStdout: (s) => out.push(s),
    });
    const code = await listCommand(makeOpts(), deps);
    expect(code).toBe(0);
    const full = out.join("");
    expect(full).toContain("#42");
    expect(full).toContain("OPEN");
    expect(full).toContain("success");
    expect(full).toContain("APPROVED");
  });

  test("zero rows after filtering: only the header line is printed", async () => {
    const out: string[] = [];
    const deps = makeDeps({
      // No siblings → enumeration yields no candidates.
      listWorktrees: async () => [mainEntry()],
      writeStdout: (s) => out.push(s),
    });
    const code = await listCommand(makeOpts(), deps);
    expect(code).toBe(0);
    const full = out.join("");
    const lines = full.replace(/\n$/, "").split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("PATH");
  });

  test("CI rollup uses the PR's statusCheckRollup", async () => {
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      listPullRequests: async () =>
        [
          makePr({
            headRefName: "feature",
            statusCheckRollup: [{ status: "IN_PROGRESS" }],
          }),
        ] as PullRequestSummary[],
      writeStdout: (s) => out.push(s),
    });
    await listCommand(makeOpts(), deps);
    expect(out.join("")).toContain("pending");
  });
});

describe("listCommand: fork-PR join", () => {
  test("local branch pr/42/<rest> joins by PR.number when headRefName differs", async () => {
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({
          path: "/repos/repo-pr-42",
          branch: "pr/42/upstream-feature",
        }),
      ],
      listPullRequests: async () =>
        [
          makePr({
            number: 42,
            // Fork PR: GH reports the upstream branch, not the local namespace.
            headRefName: "upstream-feature",
            state: "OPEN",
          }),
        ] as PullRequestSummary[],
      writeStdout: (s) => out.push(s),
    });
    const code = await listCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(out.join("")).toContain("#42");
  });

  test("leading-zero PR number in branch name is rejected (no join)", async () => {
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-pr-042", branch: "pr/042/foo" }),
      ],
      listPullRequests: async () =>
        [makePr({ number: 42, headRefName: "foo" })] as PullRequestSummary[],
      writeStdout: (s) => out.push(s),
    });
    await listCommand(makeOpts(), deps);
    const full = out.join("");
    expect(full).not.toContain("#42");
  });

  test("zero PR number in branch name is rejected (no join)", async () => {
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-pr-0", branch: "pr/0/foo" }),
      ],
      listPullRequests: async () => [],
      writeStdout: (s) => out.push(s),
    });
    const code = await listCommand(makeOpts(), deps);
    expect(code).toBe(0);
  });
});

describe("listCommand: --stale filter", () => {
  test("keeps only MERGED / CLOSED rows; OPEN and orphans dropped", async () => {
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-open", branch: "open-br" }),
        sibling({ path: "/repos/repo-merged", branch: "merged-br" }),
        sibling({ path: "/repos/repo-closed", branch: "closed-br" }),
        sibling({ path: "/repos/repo-orphan", branch: "orphan" }),
      ],
      listPullRequests: async () =>
        [
          makePr({ number: 1, headRefName: "open-br", state: "OPEN" }),
          makePr({ number: 2, headRefName: "merged-br", state: "MERGED" }),
          makePr({ number: 3, headRefName: "closed-br", state: "CLOSED" }),
        ] as PullRequestSummary[],
      writeStdout: (s) => out.push(s),
    });
    const code = await listCommand(makeOpts({ stale: true }), deps);
    expect(code).toBe(0);
    const full = out.join("");
    expect(full).toContain("/repos/repo-merged");
    expect(full).toContain("/repos/repo-closed");
    expect(full).not.toContain("/repos/repo-open");
    expect(full).not.toContain("/repos/repo-orphan");
  });
});

describe("listCommand: --json mode", () => {
  test("emits a single JSON array with no trailing newline", async () => {
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      listPullRequests: async () =>
        [
          makePr({ number: 7, headRefName: "feature", state: "OPEN" }),
        ] as PullRequestSummary[],
      writeStdout: (s) => out.push(s),
    });
    const code = await listCommand(makeOpts({ json: true }), deps);
    expect(code).toBe(0);
    const full = out.join("");
    expect(full.endsWith("\n")).toBe(false);
    const parsed = JSON.parse(full);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0]).toEqual({
      path: "/repos/repo-feature",
      branch: "feature",
      prNumber: 7,
      prState: "OPEN",
      mergeable: "MERGEABLE",
      ci: "success",
      review: "APPROVED",
      isStale: false,
    });
  });

  test("zero rows in --json mode emits '[]'", async () => {
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [mainEntry()],
      writeStdout: (s) => out.push(s),
    });
    await listCommand(makeOpts({ json: true }), deps);
    expect(out.join("")).toBe("[]");
  });
});

describe("listCommand: gh pr list failure", () => {
  test("exit 2 with formatted message on listPullRequests rejection", async () => {
    const logs: string[] = [];
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      listPullRequests: async () => {
        throw new Error("gh vibe must run from inside a git repository.");
      },
      log: (m) => logs.push(m),
      writeStdout: (s) => out.push(s),
    });
    const code = await listCommand(makeOpts(), deps);
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(logs.some((l) => /gh vibe must run from inside a git repository/.test(l))).toBe(true);
  });
});

describe("listCommand: default-branch handling", () => {
  test("getDefaultBranch failure: soft-warns and continues", async () => {
    const logs: string[] = [];
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      getDefaultBranch: async () => {
        throw new Error("Could not determine default branch.");
      },
      log: (m) => logs.push(m),
      writeStdout: (s) => out.push(s),
    });
    const code = await listCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(
      logs.some((l) => /Warning: could not resolve default branch/.test(l)),
    ).toBe(true);
    expect(out.join("")).toContain("/repos/repo-feature");
  });

  test("--allow-no-default-branch silences the warning", async () => {
    const logs: string[] = [];
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      getDefaultBranch: async () => {
        throw new Error("Could not determine default branch.");
      },
      log: (m) => logs.push(m),
      writeStdout: (s) => out.push(s),
    });
    const code = await listCommand(
      makeOpts({ allowNoDefaultBranch: true }),
      deps,
    );
    expect(code).toBe(0);
    expect(logs).toEqual([]);
  });
});

describe("listCommand: security", () => {
  test("worktree path with embedded newline is dropped with a sanitized warning", async () => {
    const logs: string[] = [];
    const out: string[] = [];
    const evilPath = "/repos/repo-evil\nrm -rf /";
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: evilPath, branch: "evil" }),
      ],
      log: (m) => logs.push(m),
      writeStdout: (s) => out.push(s),
    });
    const code = await listCommand(makeOpts(), deps);
    expect(code).toBe(0);
    expect(out.join("")).not.toContain(evilPath);
    const warnLine = logs.find((l) => /unsafe character/.test(l));
    expect(warnLine).toBeDefined();
    // The sanitized warning must NOT carry the raw newline through.
    expect(warnLine).not.toContain("\n");
  });

  test("worktree path with embedded ESC byte is dropped", async () => {
    const logs: string[] = [];
    const out: string[] = [];
    const evilPath = "/repos/repo-evil\x1b[2J";
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: evilPath, branch: "evil" }),
      ],
      log: (m) => logs.push(m),
      writeStdout: (s) => out.push(s),
    });
    await listCommand(makeOpts(), deps);
    expect(out.join("")).not.toContain("\x1b");
    expect(logs.some((l) => /unsafe character/.test(l))).toBe(true);
    for (const line of logs) {
      expect(line).not.toContain("\x1b");
    }
  });
});

describe("listCommand: fork-PR boundary cases", () => {
  // The production regex is `^pr\/([1-9]\d{0,8})\/[^/].*$` (1-9 digits total)
  // paired with `PR_NUMBER_UPPER_BOUND = 1_000_000_000`. The three rows below
  // pin the three rejection paths: (a) regex-pass + lookup-miss, (b) regex-pass
  // + bound-fail (only reachable for 10-digit numbers, which the regex already
  // rejects — so this collapses into (c) in practice), (c) regex-fail.
  test("three boundary rows all render as orphans (no PR# column)", async () => {
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-pr-9d", branch: "pr/999999999/x" }),
        sibling({ path: "/repos/repo-pr-10d-a", branch: "pr/1000000001/x" }),
        sibling({ path: "/repos/repo-pr-10d-b", branch: "pr/9999999999/x" }),
      ],
      // No matching PRs — row #1 passes the regex+bound but misses lookup,
      // rows #2 and #3 fail the regex outright (10 digits > regex max 9).
      listPullRequests: async () => [],
      writeStdout: (s) => out.push(s),
    });
    const code = await listCommand(makeOpts(), deps);
    expect(code).toBe(0);
    const full = out.join("");
    expect(full).toContain("/repos/repo-pr-9d");
    expect(full).toContain("/repos/repo-pr-10d-a");
    expect(full).toContain("/repos/repo-pr-10d-b");
    // All three should be orphans — no PR# column should ever appear.
    expect(full).not.toContain("#999999999");
    expect(full).not.toContain("#1000000001");
    expect(full).not.toContain("#9999999999");
  });

  test("regex-pass + lookup-miss for plain pr/42/foo with empty prs: orphan, no warning", async () => {
    const logs: string[] = [];
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-pr-42", branch: "pr/42/foo" }),
      ],
      listPullRequests: async () => [],
      log: (m) => logs.push(m),
      writeStdout: (s) => out.push(s),
    });
    const code = await listCommand(makeOpts(), deps);
    expect(code).toBe(0);
    const full = out.join("");
    expect(full).toContain("/repos/repo-pr-42");
    expect(full).not.toContain("#42");
    // Missing PRs are treated like any other orphan — no special warning.
    expect(logs.some((l) => /pr\/42\/foo/.test(l))).toBe(false);
  });
});

describe("listCommand: gh pr list stdout-overflow", () => {
  test("byte-cap rejection: exit 2, sanitized stderr, no partial table", async () => {
    const logs: string[] = [];
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      listPullRequests: async () => {
        // Mirrors the exact format `exec.ts` produces when `maxStdoutBytes`
        // is exceeded; see `exec.ts` overflow path.
        throw new Error("stdout exceeded 10485760 bytes");
      },
      log: (m) => logs.push(m),
      writeStdout: (s) => out.push(s),
    });
    const code = await listCommand(makeOpts(), deps);
    expect(code).toBe(2);
    expect(logs.some((l) => /stdout exceeded.*bytes/.test(l))).toBe(true);
    // No partial table should leak to stdout — writeStdout never called.
    expect(out).toEqual([]);
    // The user-visible error should NOT be a raw stack trace.
    for (const line of logs) {
      expect(line).not.toMatch(/^\s*at\s+/m);
    }
  });
});

describe("listCommand: join precedence", () => {
  // Production code (commands/list.ts::joinWorktreesWithPrs) checks
  // `byHeadRef.get(branch)` BEFORE `parseForkPrNumber` — so a direct
  // headRefName match wins over a fork-PR number match.
  test("headRefName-first wins over PR-number when both match", async () => {
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-pr-42", branch: "pr/42/foo" }),
      ],
      listPullRequests: async () =>
        [
          // PR-number match (would join if direct lookup failed).
          makePr({ number: 42, headRefName: "fork-branch", state: "OPEN" }),
          // Direct headRefName match — should win.
          makePr({
            number: 999,
            headRefName: "pr/42/foo",
            state: "MERGED",
          }),
        ] as PullRequestSummary[],
      writeStdout: (s) => out.push(s),
    });
    const code = await listCommand(makeOpts(), deps);
    expect(code).toBe(0);
    const full = out.join("");
    expect(full).toContain("#999");
    expect(full).toContain("MERGED");
    expect(full).not.toContain("#42");
  });

  // Production code (commands/list.ts::joinWorktreesWithPrs) only calls
  // `byHeadRef.set` for the FIRST PR with a given headRefName — so the
  // first PR in the input array wins on duplicates.
  test("duplicate headRefName: first PR in the list wins", async () => {
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      listPullRequests: async () =>
        [
          // First with this headRef → should win.
          makePr({ number: 11, headRefName: "feature", state: "OPEN" }),
          makePr({ number: 22, headRefName: "feature", state: "MERGED" }),
        ] as PullRequestSummary[],
      writeStdout: (s) => out.push(s),
    });
    const code = await listCommand(makeOpts(), deps);
    expect(code).toBe(0);
    const full = out.join("");
    expect(full).toContain("#11");
    expect(full).toContain("OPEN");
    expect(full).not.toContain("#22");
    expect(full).not.toContain("MERGED");
  });
});

describe("listCommand: column-position pin", () => {
  test("single matched row: cells appear at fixed indices when split by 2+ spaces", async () => {
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      listPullRequests: async () =>
        [
          makePr({ number: 42, headRefName: "feature", state: "OPEN" }),
        ] as PullRequestSummary[],
      writeStdout: (s) => out.push(s),
    });
    const code = await listCommand(makeOpts(), deps);
    expect(code).toBe(0);
    const full = out.join("").replace(/\n$/, "");
    const lines = full.split("\n");
    // Two lines expected: header + one body row.
    expect(lines.length).toBe(2);
    const bodyLine = lines[1];
    const cells = bodyLine.split(/\s{2,}/);
    // The trailing `padEnd` on the final cell produces extra whitespace; the
    // split consumes it and yields a trailing empty string. So cells[6] is
    // the cleanly-trimmed `STALE` value.
    expect(cells[0]).toBe("/repos/repo-feature");
    expect(cells[1]).toBe("feature");
    expect(cells[2]).toBe("#42");
    expect(cells[3]).toBe("OPEN");
    expect(cells[4]).toBe("success");
    expect(cells[5]).toBe("APPROVED");
    expect(cells[6]).toBe("no");
  });
});

describe("listCommand: combined flag and security regressions", () => {
  test("--stale × --json: every row is MERGED/CLOSED and isStale=true", async () => {
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-open", branch: "open-br" }),
        sibling({ path: "/repos/repo-merged", branch: "merged-br" }),
        sibling({ path: "/repos/repo-closed", branch: "closed-br" }),
        sibling({ path: "/repos/repo-orphan", branch: "orphan" }),
      ],
      listPullRequests: async () =>
        [
          makePr({ number: 1, headRefName: "open-br", state: "OPEN" }),
          makePr({ number: 2, headRefName: "merged-br", state: "MERGED" }),
          makePr({ number: 3, headRefName: "closed-br", state: "CLOSED" }),
        ] as PullRequestSummary[],
      writeStdout: (s) => out.push(s),
    });
    const code = await listCommand(
      makeOpts({ stale: true, json: true }),
      deps,
    );
    expect(code).toBe(0);
    const payload = out.join("");
    const isPlainJson = !payload.endsWith("\n");
    expect(isPlainJson).toBe(true);
    const parsed = JSON.parse(payload) as Array<{
      prState: string | null;
      isStale: boolean;
    }>;
    expect(parsed.length).toBe(2);
    for (const row of parsed) {
      const isStaleState =
        row.prState === "MERGED" || row.prState === "CLOSED";
      expect(isStaleState).toBe(true);
      expect(row.isStale).toBe(true);
    }
  });

  test("PR headRefName carrying ANSI escapes: stripped from plain stdout", async () => {
    const out: string[] = [];
    const branchWithAnsi = "feat\x1b[31m";
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        // The local branch must be a valid ref; the ANSI lives on the PR side.
        sibling({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      listPullRequests: async () =>
        [
          makePr({
            number: 7,
            // SECURITY: synthetic — `gh` should never return this, but we
            // treat the JSON as untrusted so the table must scrub it anyway.
            headRefName: branchWithAnsi,
            reviewDecision: "APPROVED\x1b[32m",
            mergeable: "MERGEABLE\x1b[33m",
          }),
        ] as PullRequestSummary[],
      writeStdout: (s) => out.push(s),
    });
    await listCommand(makeOpts(), deps);
    const full = out.join("");
    expect(full).not.toContain("\x1b");
  });

  test("ANSI in PR fields: stripped from --json output too", async () => {
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-feature", branch: "feature" }),
      ],
      listPullRequests: async () =>
        [
          makePr({
            number: 7,
            headRefName: "feature",
            reviewDecision: "APPROVED\x1b[32m",
            mergeable: "MERGEABLE\x1b[33m",
          }),
        ] as PullRequestSummary[],
      writeStdout: (s) => out.push(s),
    });
    await listCommand(makeOpts({ json: true }), deps);
    expect(out.join("")).not.toContain("\x1b");
  });

  test("orphan + --allow-no-default-branch + --stale: warning silenced, body empty", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => [
        mainEntry(),
        sibling({ path: "/repos/repo-orphan", branch: "orphan" }),
      ],
      getDefaultBranch: async () => {
        throw new Error("Could not determine default branch.");
      },
      listPullRequests: async () => [],
      writeStdout: (s) => out.push(s),
      log: (m) => logs.push(m),
    });
    const code = await listCommand(
      makeOpts({ stale: true, allowNoDefaultBranch: true }),
      deps,
    );
    expect(code).toBe(0);
    // Default-branch resolution failed but the warning must be silenced.
    expect(logs.some((l) => /could not resolve default branch/i.test(l))).toBe(
      false,
    );
    // Orphan + --stale = no body rows; only the header survives.
    const full = out.join("").replace(/\n$/, "");
    const lines = full.split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("PATH");
  });

  test("non-functional smoke: 500 worktrees × 1000 PRs joins in under 1 s", async () => {
    const W = 500;
    const P = 1000;
    const entries: WorktreeEntry[] = [mainEntry()];
    const prs: PullRequestSummary[] = [];
    for (let i = 0; i < W; i++) {
      entries.push(
        sibling({ path: `/repos/repo-b${i}`, branch: `b${i}` }),
      );
    }
    for (let i = 0; i < P; i++) {
      prs.push(makePr({ number: i + 1, headRefName: `b${i}` }));
    }
    const out: string[] = [];
    const deps = makeDeps({
      listWorktrees: async () => entries,
      listPullRequests: async () => prs,
      writeStdout: (s) => out.push(s),
    });
    const start = Date.now();
    const code = await listCommand(makeOpts(), deps);
    const elapsedMs = Date.now() - start;
    expect(code).toBe(0);
    expect(elapsedMs).toBeLessThan(1000);
    // Sanity: every worktree row is rendered.
    const lines = out.join("").replace(/\n$/, "").split("\n");
    expect(lines.length).toBe(W + 1);
  });
});
