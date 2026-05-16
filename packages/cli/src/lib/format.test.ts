import { describe, expect, test } from "bun:test";
import { maskSecrets, sanitizeForLog, stripAnsi } from "./format.ts";

describe("stripAnsi", () => {
  test("removes color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m text")).toBe("red text");
  });

  test("removes multi-arg SGR codes", () => {
    expect(stripAnsi("\x1b[1;33;40mbold yellow on black\x1b[0m")).toBe(
      "bold yellow on black",
    );
  });

  test("leaves plain strings alone", () => {
    expect(stripAnsi("hello")).toBe("hello");
  });

  test("handles empty input", () => {
    expect(stripAnsi("")).toBe("");
  });
});

describe("maskSecrets", () => {
  test("masks classic gh personal access tokens", () => {
    expect(maskSecrets("token=ghp_abcdefghijklmnopqrstuvwxyz1234")).toBe(
      "token=gh*_***",
    );
  });

  test("masks gh OAuth / server-side tokens", () => {
    expect(maskSecrets("ghs_abcdefghijklmnopqrstuvwxyz1234 leaked")).toBe(
      "gh*_*** leaked",
    );
  });

  test("masks fine-grained PATs", () => {
    expect(
      maskSecrets("token=github_pat_ABCDEFGHIJabcdefghij_KLMNOPQRSTuvwxyz"),
    ).toBe("token=github_pat_***");
  });

  test("masks URL-embedded credentials", () => {
    expect(
      maskSecrets(
        "clone https://x-access-token:ghs_secret123@github.com/owner/repo",
      ),
    ).toBe("clone https://***@github.com/owner/repo");
  });

  test("leaves non-secret text alone", () => {
    expect(maskSecrets("normal error message")).toBe("normal error message");
  });

  test("leaves short token-shaped strings alone", () => {
    // Below the 20-char floor; not confidently a token.
    expect(maskSecrets("ghp_short")).toBe("ghp_short");
  });
});

describe("sanitizeForLog", () => {
  test("strips ANSI sequences", () => {
    expect(sanitizeForLog("\x1b[31mred\x1b[0m text")).toBe("red text");
  });

  test("replaces U+202E (RIGHT-TO-LEFT OVERRIDE) with '?'", () => {
    expect(sanitizeForLog("a‮b")).toBe("a?b");
  });

  test("replaces NUL and other Cc characters with '?'", () => {
    expect(sanitizeForLog("a\x00b")).toBe("a?b");
    expect(sanitizeForLog("a\x07b")).toBe("a?b");
    expect(sanitizeForLog("a\x1bb")).toBe("a?b");
  });

  test("passes through normal ASCII and Japanese unchanged", () => {
    expect(sanitizeForLog("hello")).toBe("hello");
    expect(sanitizeForLog("こんにちは")).toBe("こんにちは");
    expect(sanitizeForLog("/repos/my-repo")).toBe("/repos/my-repo");
  });
});
