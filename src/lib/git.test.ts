import { describe, expect, test } from "bun:test";
import { ExecError } from "./exec.ts";
import { formatGitError, parseWorktreeListZ } from "./git.ts";

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
