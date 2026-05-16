import { describe, expect, test } from "bun:test";
import { ExecError } from "./exec.ts";
import { formatGitError } from "./git.ts";

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
