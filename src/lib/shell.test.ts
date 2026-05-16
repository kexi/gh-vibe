import { describe, expect, test } from "bun:test";
import { assertSafeShellPath, shellQuote } from "./shell.ts";

describe("shellQuote", () => {
  test("empty string becomes a pair of single quotes", () => {
    expect(shellQuote("")).toBe("''");
  });

  test("escapes embedded single quote with '\\''", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  test("preserves spaces inside single quotes", () => {
    expect(shellQuote("foo bar")).toBe("'foo bar'");
  });

  test("prevents shell expansion / command chaining", () => {
    // Single quotes disable $-expansion and command separators alike.
    expect(shellQuote("$HOME; rm -rf /")).toBe("'$HOME; rm -rf /'");
  });

  test("plain absolute path is wrapped in single quotes", () => {
    expect(shellQuote("/safe/path")).toBe("'/safe/path'");
  });
});

describe("assertSafeShellPath", () => {
  test("accepts a plain absolute path", () => {
    expect(() => assertSafeShellPath("/safe/path")).not.toThrow();
  });

  test("accepts non-ASCII Unicode like Japanese", () => {
    expect(() => assertSafeShellPath("/日本語/パス")).not.toThrow();
  });

  test("rejects embedded newline", () => {
    expect(() => assertSafeShellPath("/path\nwith\nnewline")).toThrow(
      "control characters",
    );
  });

  test("rejects embedded NUL", () => {
    expect(() => assertSafeShellPath("/path\0evil")).toThrow(
      "control characters",
    );
  });

  test("rejects ESC (used to start ANSI escapes)", () => {
    expect(() => assertSafeShellPath("/path\x1b[evil")).toThrow(
      "control characters",
    );
  });

  test("rejects carriage return", () => {
    expect(() => assertSafeShellPath("/path\rwith\rCR")).toThrow(
      "control characters",
    );
  });
});
