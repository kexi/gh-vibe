import { describe, expect, test } from "bun:test";
import { ExecError } from "./exec.ts";
import {
  assertValidRefName,
  enumerateVibeWorktrees,
  fetchBranch,
  formatGitError,
  getDefaultBranch,
  getMainWorktreePath,
  listWorktrees,
  parseWorktreeListAll,
  parseWorktreeListZ,
  type WorktreeEntry,
} from "./git.ts";

function makeExecError(stderr: string, stdout = "", exitCode = 128): ExecError {
  return new ExecError({
    cmd: "git",
    args: ["fetch", "origin", "feature"],
    stdout,
    stderr,
    exitCode,
  });
}

describe("formatGitError", () => {
  test("remote ref not found, refspec is plain branch", () => {
    const err = makeExecError("fatal: couldn't find remote ref feature\n");
    const msg = formatGitError(err, { remote: "origin", refspec: "feature" });
    expect(msg).toBe("Branch 'feature' not found on remote 'origin'.");
  });

  test("remote ref not found, refspec is src:dst", () => {
    const err = makeExecError("fatal: couldn't find remote ref feature\n");
    const msg = formatGitError(err, {
      remote: "origin",
      refspec: "feature:pr/42/feature",
    });
    expect(msg).toBe("Branch 'feature' not found on remote 'origin'.");
  });

  test("remote ref not found without refspec context", () => {
    const err = makeExecError("fatal: couldn't find remote ref nope\n");
    const msg = formatGitError(err, {});
    expect(msg).toBe("Branch ref not found.");
  });

  test("HTTPS authentication failed", () => {
    const err = makeExecError(
      "fatal: Authentication failed for 'https://github.com/owner/repo/'\n",
    );
    const msg = formatGitError(err, {});
    expect(msg).toBe(
      "git authentication failed. Check `gh auth status` or your SSH key.",
    );
  });

  test("SSH publickey denied", () => {
    const err = makeExecError("git@github.com: Permission denied (publickey).\n");
    const msg = formatGitError(err, {});
    expect(msg).toBe(
      "git authentication failed. Check `gh auth status` or your SSH key.",
    );
  });

  test("generic ANSI-wrapped stderr is cleaned up", () => {
    const err = makeExecError("\x1b[31mfatal: something else\x1b[0m\n");
    const msg = formatGitError(err, {});
    expect(msg).toBe("fatal: something else");
  });

  test("masks secrets in generic stderr", () => {
    const err = makeExecError(
      "fatal: unable to access 'https://x:ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@github.com/foo/bar': 403\n",
    );
    const msg = formatGitError(err, {});
    expect(msg).not.toContain("ghp_aaaa");
    expect(msg).toContain("***@github.com");
  });

  test("falls back to exit code when stderr and stdout are empty", () => {
    const err = makeExecError("", "", 130);
    const msg = formatGitError(err, {});
    expect(msg).toBe("git exited with code 130");
  });
});

describe("parseWorktreeListZ", () => {
  /**
   * Helper: build a `git worktree list --porcelain -z` payload from groups of
   * attribute lines. NUL separates lines, double-NUL separates groups.
   */
  function buildOutput(groups: string[][]): string {
    return groups.map((lines) => lines.join("\0")).join("\0\0");
  }

  test("returns the worktree path for a matching branch", () => {
    const out = buildOutput([
      ["worktree /repos/main", "HEAD abc123", "branch refs/heads/main"],
      [
        "worktree /repos/feature",
        "HEAD def456",
        "branch refs/heads/feature",
      ],
    ]);
    expect(parseWorktreeListZ(out, "feature")).toBe("/repos/feature");
  });

  test("returns null when no group references the branch", () => {
    const out = buildOutput([
      ["worktree /repos/main", "HEAD abc123", "branch refs/heads/main"],
    ]);
    expect(parseWorktreeListZ(out, "missing")).toBeNull();
  });

  test("ignores detached-HEAD worktrees", () => {
    const out = buildOutput([
      ["worktree /repos/detached", "HEAD abc123", "detached"],
      ["worktree /repos/feature", "HEAD def456", "branch refs/heads/feature"],
    ]);
    expect(parseWorktreeListZ(out, "feature")).toBe("/repos/feature");
  });

  test("preserves paths that contain spaces", () => {
    const out = buildOutput([
      [
        "worktree /repos/with space",
        "HEAD abc123",
        "branch refs/heads/feature",
      ],
    ]);
    expect(parseWorktreeListZ(out, "feature")).toBe("/repos/with space");
  });

  test("handles namespaced branch names like pr/42/feature", () => {
    const out = buildOutput([
      [
        "worktree /repos/pr-42",
        "HEAD abc123",
        "branch refs/heads/pr/42/feature",
      ],
    ]);
    expect(parseWorktreeListZ(out, "pr/42/feature")).toBe("/repos/pr-42");
  });

  test("does not match a branch that is a prefix of another", () => {
    // Guard against accidental `startsWith`-style matching.
    const out = buildOutput([
      [
        "worktree /repos/feature-x",
        "HEAD abc123",
        "branch refs/heads/feature-x",
      ],
    ]);
    expect(parseWorktreeListZ(out, "feature")).toBeNull();
  });
});

describe("fetchBranch", () => {
  test("argv contains the `--` separator before the refspec", async () => {
    const calls: Array<[string, string[]]> = [];
    const fakeExec = async (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return "";
    };

    await fetchBranch("origin", "feature", fakeExec);

    expect(calls).toEqual([["git", ["fetch", "origin", "--", "feature"]]]);
  });

  test("translates 'couldn't find remote ref' into the friendly message", async () => {
    const fakeExec = async (_cmd: string, args: string[]) => {
      throw new ExecError({
        cmd: "git",
        args,
        stdout: "",
        stderr: "fatal: couldn't find remote ref feature\n",
        exitCode: 128,
      });
    };

    await expect(
      fetchBranch("origin", "feature", fakeExec),
    ).rejects.toThrow("Branch 'feature' not found on remote 'origin'.");
  });
});

describe("getDefaultBranch", () => {
  test("happy path: strips the `origin/` prefix", async () => {
    const fakeExec = async (_cmd: string, _args: string[]) => "origin/main\n";
    expect(await getDefaultBranch(fakeExec)).toBe("main");
  });

  test("'is not a symbolic ref' is translated to a friendly hint", async () => {
    const fakeExec = async (_cmd: string, args: string[]) => {
      throw new ExecError({
        cmd: "git",
        args,
        stdout: "",
        stderr: "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n",
        exitCode: 1,
      });
    };

    await expect(getDefaultBranch(fakeExec)).rejects.toThrow(
      /Could not determine default branch/,
    );
    await expect(getDefaultBranch(fakeExec)).rejects.toThrow(
      /git remote set-head origin --auto/,
    );
  });

  // SECURITY: raw stderr (which may contain tokens) must never reach the
  // user-facing error message. The generic-fallback branch must mask secrets.
  test("does NOT leak raw stderr (e.g. embedded gh token) into the thrown message", async () => {
    const token = "ghp_FAKETOKENVALUE1234567890abcdEFGH";
    const fakeExec = async (_cmd: string, args: string[]) => {
      throw new ExecError({
        cmd: "git",
        args,
        stdout: "",
        // Generic-looking failure (not the symbolic-ref pattern) so we exercise
        // the fallback branch.
        stderr: `fatal: unable to access 'https://x:${token}@github.com/foo/bar': 403\n`,
        exitCode: 1,
      });
    };

    try {
      await getDefaultBranch(fakeExec);
      throw new Error("expected getDefaultBranch to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(token);
      expect(message).toContain("***@github.com");
    }
  });
});

describe("parseWorktreeListAll", () => {
  function buildOutput(groups: string[][]): string {
    return groups.map((lines) => lines.join("\0")).join("\0\0");
  }

  test("empty input → empty array", () => {
    expect(parseWorktreeListAll("")).toEqual([]);
  });

  test("first entry is marked isMain=true; others false", () => {
    const out = buildOutput([
      ["worktree /repos/main", "HEAD abc", "branch refs/heads/main"],
      ["worktree /repos/feature", "HEAD def", "branch refs/heads/feature"],
    ]);
    const entries = parseWorktreeListAll(out);
    expect(entries.length).toBe(2);
    expect(entries[0].isMain).toBe(true);
    expect(entries[1].isMain).toBe(false);
  });

  test("bare entry → isBare=true, branch=null", () => {
    const out = buildOutput([
      ["worktree /repos/bare", "bare"],
    ]);
    const entries = parseWorktreeListAll(out);
    expect(entries[0].isBare).toBe(true);
    expect(entries[0].branch).toBeNull();
  });

  test("detached entry → isDetached=true, branch=null", () => {
    const out = buildOutput([
      ["worktree /repos/main", "HEAD abc", "branch refs/heads/main"],
      ["worktree /repos/detached", "HEAD def", "detached"],
    ]);
    const entries = parseWorktreeListAll(out);
    expect(entries[1].isDetached).toBe(true);
    expect(entries[1].branch).toBeNull();
  });

  test("normal entry → branch set without refs/heads/ prefix", () => {
    const out = buildOutput([
      ["worktree /repos/main", "HEAD abc", "branch refs/heads/main"],
      [
        "worktree /repos/feature",
        "HEAD def",
        "branch refs/heads/pr/42/feature",
      ],
    ]);
    const entries = parseWorktreeListAll(out);
    expect(entries[1].branch).toBe("pr/42/feature");
  });

  test("path with spaces preserved", () => {
    const out = buildOutput([
      [
        "worktree /repos/with space",
        "HEAD abc",
        "branch refs/heads/main",
      ],
    ]);
    expect(parseWorktreeListAll(out)[0].path).toBe("/repos/with space");
  });

  test("multiple groups: order preserved, only first has isMain=true", () => {
    const out = buildOutput([
      ["worktree /repos/a", "HEAD a", "branch refs/heads/a"],
      ["worktree /repos/b", "HEAD b", "branch refs/heads/b"],
      ["worktree /repos/c", "HEAD c", "branch refs/heads/c"],
    ]);
    const entries = parseWorktreeListAll(out);
    expect(entries.map((e) => e.path)).toEqual([
      "/repos/a",
      "/repos/b",
      "/repos/c",
    ]);
    expect(entries.map((e) => e.isMain)).toEqual([true, false, false]);
  });
});

describe("getMainWorktreePath", () => {
  function buildOutput(groups: string[][]): string {
    return groups.map((lines) => lines.join("\0")).join("\0\0");
  }

  test("returns first entry's path", async () => {
    const fakeExec = async (_cmd: string, _args: string[]) =>
      buildOutput([
        ["worktree /repos/main", "HEAD abc", "branch refs/heads/main"],
        ["worktree /repos/feature", "HEAD def", "branch refs/heads/feature"],
      ]);
    expect(await getMainWorktreePath(fakeExec)).toBe("/repos/main");
  });
});

describe("listWorktrees", () => {
  test("invokes git with --porcelain -z", async () => {
    const calls: Array<[string, string[]]> = [];
    const fakeExec = async (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return "";
    };
    await listWorktrees(fakeExec);
    expect(calls).toEqual([["git", ["worktree", "list", "--porcelain", "-z"]]]);
  });
});

describe("enumerateVibeWorktrees", () => {
  function makeMain(): WorktreeEntry {
    return {
      path: "/repos/repo",
      branch: "main",
      isMain: true,
      isBare: false,
      isDetached: false,
    };
  }

  function makeSibling(overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
    return {
      path: "/repos/repo-feature",
      branch: "feature",
      isMain: false,
      isBare: false,
      isDetached: false,
      ...overrides,
    };
  }

  test("throws when entries is empty", () => {
    expect(() =>
      enumerateVibeWorktrees({ entries: [], defaultBranch: "main" }),
    ).toThrow(/Could not determine main worktree/);
  });

  test("sibling worktrees on a different branch are candidates", () => {
    const result = enumerateVibeWorktrees({
      entries: [makeMain(), makeSibling()],
      defaultBranch: "main",
    });
    expect(result.candidates.map((c) => c.path)).toEqual([
      "/repos/repo-feature",
    ]);
    expect(result.mainPath).toBe("/repos/repo");
  });

  test("non-sibling worktrees are skipped with reason 'non-sibling'", () => {
    const result = enumerateVibeWorktrees({
      entries: [makeMain(), makeSibling({ path: "/elsewhere/repo-feature" })],
      defaultBranch: "main",
    });
    expect(result.candidates).toEqual([]);
    const skip = result.skips.find((s) => s.entry.path === "/elsewhere/repo-feature");
    expect(skip?.reason).toBe("non-sibling");
  });

  test("siblings without the repo-prefix basename are skipped", () => {
    const result = enumerateVibeWorktrees({
      entries: [
        makeMain(),
        makeSibling({ path: "/repos/unrelated", branch: "x" }),
      ],
      defaultBranch: "main",
    });
    expect(result.candidates).toEqual([]);
    const skip = result.skips.find((s) => s.entry.path === "/repos/unrelated");
    expect(skip?.reason).toBe("no-sibling-prefix");
  });

  test("branch === defaultBranch is skipped", () => {
    const result = enumerateVibeWorktrees({
      entries: [
        makeMain(),
        makeSibling({ path: "/repos/repo-main", branch: "main" }),
      ],
      defaultBranch: "main",
    });
    expect(result.candidates).toEqual([]);
    const skip = result.skips.find((s) => s.entry.branch === "main" && !s.entry.isMain);
    expect(skip?.reason).toBe("is-default-branch");
  });

  test("defaultBranch=null disables the default-branch skip rule", () => {
    // `list`'s soft-fail policy: no defaultBranch known → do not pre-filter
    // by branch name. (`clean` adds an extra likely-name guard upstream.)
    const result = enumerateVibeWorktrees({
      entries: [
        makeMain(),
        makeSibling({ path: "/repos/repo-main", branch: "main" }),
      ],
      defaultBranch: null,
    });
    expect(result.candidates.map((c) => c.branch)).toEqual(["main"]);
  });

  test("bare / detached / branchless siblings are skipped", () => {
    const result = enumerateVibeWorktrees({
      entries: [
        makeMain(),
        makeSibling({ path: "/repos/repo-bare", branch: null, isBare: true }),
        makeSibling({
          path: "/repos/repo-detached",
          branch: null,
          isDetached: true,
        }),
        makeSibling({ path: "/repos/repo-orphan", branch: null }),
      ],
      defaultBranch: "main",
    });
    expect(result.candidates).toEqual([]);
    expect(new Set(result.skips.map((s) => s.reason))).toEqual(
      new Set(["main", "bare", "detached", "no-branch"]),
    );
  });

  test("dash-prefixed branch is skipped", () => {
    const result = enumerateVibeWorktrees({
      entries: [
        makeMain(),
        makeSibling({ path: "/repos/repo--evil", branch: "-evil" }),
      ],
      defaultBranch: "main",
    });
    expect(result.candidates).toEqual([]);
    expect(result.skips.some((s) => s.reason === "dash-prefixed")).toBe(true);
  });

  test("branch failing assertValidRefName is skipped with detail", () => {
    const result = enumerateVibeWorktrees({
      entries: [
        makeMain(),
        makeSibling({ path: "/repos/repo-bad", branch: "bad~ref" }),
      ],
      defaultBranch: "main",
    });
    expect(result.candidates).toEqual([]);
    const skip = result.skips.find((s) => s.reason === "invalid-ref-name");
    expect(skip?.detail).toMatch(/Invalid ref name/);
  });
});

describe("assertValidRefName", () => {
  test.each([
    ["plain branch", "main"],
    ["slashed branch", "feature/foo"],
    // `feature.lockfile` does NOT end the segment in `.lock`, only contains it
    // as a prefix; git accepts this and so must we.
    ["segment with .lock prefix but other suffix", "feature.lockfile"],
  ])("accepts %s", (_label, name) => {
    expect(() => assertValidRefName(name)).not.toThrow();
  });

  test.each([
    ["dash-prefixed option-looking", "--upload-pack=evil"],
    ["empty string", ""],
    ["embedded space", "foo bar"],
    ["double dot", "foo..bar"],
    // New cases added when we replaced the `git check-ref-format` subprocess
    // with an inline regex; sanity-check the rules we now enforce ourselves.
    ["reflog sequence @{", "@{foo}"],
    ["segment starting with '.'", "foo/.bar"],
    ["trailing slash", "foo/"],
    [".lock suffix", "feature.lock"],
    // R1 regression coverage: real `git check-ref-format --allow-onelevel`
    // rejects these, the previous regex did not.
    ["leading slash", "/foo"],
    ["mid-path .lock component", "foo.lock/bar"],
    ["leading .lock component", ".lock/bar"],
  ])("rejects %s", (_label, name) => {
    expect(() => assertValidRefName(name)).toThrow(/Invalid ref name/);
  });
});
