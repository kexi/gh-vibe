import { describe, expect, test } from "bun:test";
import { ExecError } from "./exec.ts";
import { formatGhError } from "./gh.ts";

function makeExecError(stderr: string, stdout = "", exitCode = 1): ExecError {
  return new ExecError({
    cmd: "gh",
    args: ["pr", "view", "417", "--json", "number"],
    stdout,
    stderr,
    exitCode,
  });
}

describe("formatGhError", () => {
  test("PR not found with ownerRepo", () => {
    const err = makeExecError(
      "GraphQL: Could not resolve to a PullRequest with the number of 417. (repository.pullRequest)\n",
    );
    const msg = formatGhError(err, {
      prRef: "417",
      ownerRepo: "kexi/gh-vibe",
    });
    expect(msg).toBe("PR #417 not found in kexi/gh-vibe.");
  });

  test("PR not found without ownerRepo", () => {
    const err = makeExecError(
      "GraphQL: Could not resolve to a PullRequest with the number of 417.\n",
    );
    const msg = formatGhError(err, { prRef: "417" });
    expect(msg).toBe("PR #417 not found.");
  });

  test("not a git repository", () => {
    const err = makeExecError(
      "fatal: not a git repository (or any of the parent directories): .git\n",
    );
    const msg = formatGhError(err, {});
    expect(msg).toBe("gh vibe must run from inside a git repository.");
  });

  test("generic stderr is trimmed", () => {
    const err = makeExecError("   something went wrong   \n");
    const msg = formatGhError(err, { prRef: "417" });
    expect(msg).toBe("something went wrong");
  });

  test("generic falls back to stdout if stderr is empty", () => {
    const err = makeExecError("", "  stdout message  \n");
    const msg = formatGhError(err, {});
    expect(msg).toBe("stdout message");
  });

  test("generic falls back to exit code message if both empty", () => {
    const err = makeExecError("", "", 42);
    const msg = formatGhError(err, {});
    expect(msg).toBe("gh exited with code 42");
  });

  // T-A1: defensive `--json <fields>` stripping in generic branch
  test("strips `--json <fields>` from generic stderr", () => {
    const err = makeExecError(
      "failed to run gh pr view 417 --json number,title: boom\n",
    );
    const msg = formatGhError(err, { prRef: "417" });
    expect(msg).not.toContain("--json");
    expect(msg).not.toContain("number,title");
    expect(msg).toContain("boom");
  });

  // T-A3: PR URL passed as prRef should not crash and should remain intact
  test("PR URL prRef is embedded without breaking the URL", () => {
    const err = makeExecError(
      "GraphQL: Could not resolve to a PullRequest with the number of 123.\n",
    );
    const url = "https://github.com/owner/repo/pull/123";
    const msg = formatGhError(err, { prRef: url });
    expect(msg).toBe(`PR #${url} not found.`);
    expect(msg).toContain(url);
  });

  // T-A4: only ownerRepo given, prRef undefined
  test("PR not found message when only ownerRepo is provided", () => {
    const err = makeExecError(
      "GraphQL: Could not resolve to a PullRequest with the number of 1.\n",
    );
    const msg = formatGhError(err, { ownerRepo: "owner/repo" });
    expect(msg).toBe("PR not found in owner/repo.");
  });

  // T-B1: stderr is whitespace-only and stdout is empty → exit code fallback
  test("whitespace-only stderr with empty stdout falls back to exit code", () => {
    const err = makeExecError("\n\n", "", 7);
    const msg = formatGhError(err, {});
    expect(msg).toBe("gh exited with code 7");
  });

  // T-A6: ANSI escape sequences should not break detection nor leak into output
  test("ANSI-wrapped PR-not-found stderr is still detected", () => {
    const err = makeExecError(
      "\x1b[31mGraphQL: Could not resolve to a PullRequest with the number of 417.\x1b[0m\n",
    );
    const msg = formatGhError(err, {
      prRef: "417",
      ownerRepo: "kexi/gh-vibe",
    });
    expect(msg).toBe("PR #417 not found in kexi/gh-vibe.");
    expect(msg).not.toContain("\x1b[");
  });

  test("ANSI-wrapped generic stderr is cleaned up", () => {
    const err = makeExecError("\x1b[1msomething went wrong\x1b[0m\n");
    const msg = formatGhError(err, {});
    expect(msg).toBe("something went wrong");
    expect(msg).not.toContain("\x1b[");
  });
});
