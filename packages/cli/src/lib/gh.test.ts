import { describe, expect, test } from "bun:test";
import { ExecError } from "./exec.ts";
import {
  PrNotFoundError,
  formatGhError,
  listPullRequests,
  viewIssue,
  viewPullRequest,
} from "./gh.ts";

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

  test("Issue not found with ownerRepo", () => {
    const err = makeExecError(
      "GraphQL: Could not resolve to an Issue with the number of 42. (repository.issue)\n",
    );
    const msg = formatGhError(err, {
      issueRef: "42",
      ownerRepo: "kexi/gh-vibe",
    });
    expect(msg).toBe("Issue #42 not found in kexi/gh-vibe.");
  });

  test("Issue not found without ownerRepo", () => {
    const err = makeExecError(
      "GraphQL: Could not resolve to an Issue with the number of 42.\n",
    );
    const msg = formatGhError(err, { issueRef: "42" });
    expect(msg).toBe("Issue #42 not found.");
  });

  test("PR-not-found context still works alongside the new Issue branch", () => {
    const err = makeExecError(
      "GraphQL: Could not resolve to a PullRequest with the number of 417.\n",
    );
    expect(formatGhError(err, { prRef: "417" })).toBe("PR #417 not found.");
  });
});

describe("viewPullRequest", () => {
  // R-3: pin that the third `_exec` parameter has a production default
  // (`execOrThrow`). The arity check guards against a refactor that
  // accidentally drops the `= execOrThrow` default — JS reports `.length`
  // as the number of params before the first defaulted one, so it MUST be
  // 2 (prRef, ownerRepo).
  test("has arity 2 (third _exec parameter is defaulted)", () => {
    expect(viewPullRequest.length).toBe(2);
  });

  // Smoke: invoking with a one-shot injected exec returning parseable JSON
  // must NOT throw a TypeError synchronously. Without the test host needing
  // a real `gh` binary, this still confirms the function is callable with
  // the seam plumbed correctly.
  test("does not throw TypeError when invoked with injected exec", async () => {
    const fakeExec = async (_cmd: string, _args: string[]) =>
      JSON.stringify({
        number: 1,
        title: "t",
        url: "u",
        headRefName: "h",
        baseRefName: "b",
        isCrossRepository: false,
        headRepository: { name: "r" },
        headRepositoryOwner: { login: "o" },
        state: "OPEN",
      });
    let threwTypeError = false;
    try {
      await viewPullRequest("1", undefined, fakeExec);
    } catch (err) {
      if (err instanceof TypeError) threwTypeError = true;
    }
    expect(threwTypeError).toBe(false);
  });

  test("throws PrNotFoundError when stderr matches 'Could not resolve to a PullRequest'", async () => {
    const fakeExec = async (_cmd: string, args: string[]) => {
      throw new ExecError({
        cmd: "gh",
        args,
        stdout: "",
        stderr:
          "GraphQL: Could not resolve to a PullRequest with the number of 417.\n",
        exitCode: 1,
      });
    };

    let caught: unknown;
    try {
      await viewPullRequest("417", undefined, fakeExec);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PrNotFoundError);
    expect((caught as Error).message).toBe("PR #417 not found.");
  });

  test("throws plain Error (NOT PrNotFoundError) for unrelated failures", async () => {
    const fakeExec = async (_cmd: string, args: string[]) => {
      throw new ExecError({
        cmd: "gh",
        args,
        stdout: "",
        stderr: "something else failed\n",
        exitCode: 1,
      });
    };

    let caught: unknown;
    try {
      await viewPullRequest("417", undefined, fakeExec);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof PrNotFoundError).toBe(false);
  });

  test("PrNotFoundError.message matches the existing formatGhError shape (with ownerRepo)", async () => {
    const fakeExec = async (_cmd: string, args: string[]) => {
      throw new ExecError({
        cmd: "gh",
        args,
        stdout: "",
        stderr:
          "GraphQL: Could not resolve to a PullRequest with the number of 1.\n",
        exitCode: 1,
      });
    };
    await expect(
      viewPullRequest("1", "kexi/gh-vibe", fakeExec),
    ).rejects.toThrow("PR #1 not found in kexi/gh-vibe.");
  });
});

describe("listPullRequests", () => {
  test("invokes gh with the canonical argv (json fields, limit, state=all)", async () => {
    const calls: Array<[string, string[]]> = [];
    const fakeExec = async (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return "[]";
    };
    await listPullRequests({ limit: 30 }, fakeExec);
    expect(calls.length).toBe(1);
    const [cmd, args] = calls[0];
    expect(cmd).toBe("gh");
    expect(args[0]).toBe("pr");
    expect(args[1]).toBe("list");
    expect(args).toContain("--json");
    const jsonIdx = args.indexOf("--json");
    expect(args[jsonIdx + 1]).toContain("headRefName");
    expect(args[jsonIdx + 1]).toContain("statusCheckRollup");
    expect(args).toContain("--limit");
    expect(args[args.indexOf("--limit") + 1]).toBe("30");
    expect(args).toContain("--state");
    expect(args[args.indexOf("--state") + 1]).toBe("all");
  });

  test("parses well-formed JSON into PullRequestSummary[]", async () => {
    const fakeExec = async (_cmd: string, _args: string[]) =>
      JSON.stringify([
        {
          number: 1,
          headRefName: "feat/foo",
          state: "OPEN",
          mergeable: "MERGEABLE",
          statusCheckRollup: [{ conclusion: "SUCCESS" }],
          reviewDecision: "APPROVED",
        },
        {
          number: 2,
          headRefName: "fix/bar",
          state: "MERGED",
          mergeable: null,
          statusCheckRollup: null,
          reviewDecision: null,
        },
      ]);
    const result = await listPullRequests({ limit: 10 }, fakeExec);
    expect(result.length).toBe(2);
    expect(result[0].number).toBe(1);
    expect(result[0].headRefName).toBe("feat/foo");
    expect(result[1].state).toBe("MERGED");
  });

  test("drops elements failing the structural guard (number / headRefName)", async () => {
    const fakeExec = async (_cmd: string, _args: string[]) =>
      JSON.stringify([
        { number: 1, headRefName: "ok", state: "OPEN" },
        // missing number
        { headRefName: "no-num", state: "OPEN" },
        // wrong number type
        { number: "2", headRefName: "str-num", state: "OPEN" },
        // unsafe (negative) number
        { number: -3, headRefName: "neg", state: "OPEN" },
        // missing headRefName
        { number: 4, state: "OPEN" },
        // wrong headRefName type
        { number: 5, headRefName: 42, state: "OPEN" },
        { number: 6, headRefName: "also-ok", state: "MERGED" },
      ]);
    const result = await listPullRequests({ limit: 100 }, fakeExec);
    expect(result.map((p) => p.number)).toEqual([1, 6]);
  });

  test("non-array JSON returns []", async () => {
    const fakeExec = async (_cmd: string, _args: string[]) => '{"oops":1}';
    expect(await listPullRequests({ limit: 1 }, fakeExec)).toEqual([]);
  });

  test("gh failure surfaces via formatGhError (PR-not-found style is irrelevant here, generic stderr)", async () => {
    const fakeExec = async (_cmd: string, args: string[]) => {
      throw new ExecError({
        cmd: "gh",
        args,
        stdout: "",
        stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
        exitCode: 1,
      });
    };
    await expect(listPullRequests({ limit: 30 }, fakeExec)).rejects.toThrow(
      "gh vibe must run from inside a git repository.",
    );
  });

  test("SECURITY: secrets in stderr are masked in the thrown message", async () => {
    const token = "ghp_FAKETOKENVALUE1234567890abcdEFGH";
    const fakeExec = async (_cmd: string, args: string[]) => {
      throw new ExecError({
        cmd: "gh",
        args,
        stdout: "",
        stderr: `unable to access https://x:${token}@github.com/owner/repo\n`,
        exitCode: 1,
      });
    };
    try {
      await listPullRequests({ limit: 30 }, fakeExec);
      throw new Error("expected listPullRequests to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(token);
      expect(message).toContain("***@github.com");
    }
  });

  test("truncated JSON propagates SyntaxError (the caller pipes through formatGhError)", async () => {
    const fakeExec = async (_cmd: string, _args: string[]) =>
      '[{"number":1,"head';
    await expect(listPullRequests({ limit: 30 }, fakeExec)).rejects.toThrow(
      SyntaxError,
    );
  });
});

describe("viewIssue", () => {
  test("parses gh JSON into an Issue", async () => {
    const fakeExec = async (_cmd: string, _args: string[]) =>
      JSON.stringify({
        number: 7,
        title: "Bug: login broken",
        url: "https://github.com/owner/repo/issues/7",
        state: "OPEN",
        labels: [{ name: "bug" }, { name: "priority/high" }],
      });

    const issue = await viewIssue("7", undefined, fakeExec);

    expect(issue.number).toBe(7);
    expect(issue.title).toBe("Bug: login broken");
    expect(issue.state).toBe("OPEN");
    expect(issue.labels).toEqual([
      { name: "bug" },
      { name: "priority/high" },
    ]);
  });

  test("translates 'Could not resolve to an Issue' into the friendly message", async () => {
    const fakeExec = async (_cmd: string, args: string[]) => {
      throw new ExecError({
        cmd: "gh",
        args,
        stdout: "",
        stderr:
          "GraphQL: Could not resolve to an Issue with the number of 999.\n",
        exitCode: 1,
      });
    };

    await expect(viewIssue("999", undefined, fakeExec)).rejects.toThrow(
      "Issue #999 not found.",
    );
  });

  test("includes ownerRepo in the not-found message when supplied", async () => {
    const fakeExec = async (_cmd: string, args: string[]) => {
      throw new ExecError({
        cmd: "gh",
        args,
        stdout: "",
        stderr:
          "GraphQL: Could not resolve to an Issue with the number of 1.\n",
        exitCode: 1,
      });
    };

    await expect(
      viewIssue("1", "kexi/gh-vibe", fakeExec),
    ).rejects.toThrow("Issue #1 not found in kexi/gh-vibe.");
  });
});
