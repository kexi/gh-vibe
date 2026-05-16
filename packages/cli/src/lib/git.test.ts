import { describe, expect, test } from "bun:test";
import { ExecError } from "./exec.ts";
import {
  assertValidRefName,
  fetchBranch,
  formatGitError,
  getDefaultBranch,
  parseWorktreeListZ,
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
