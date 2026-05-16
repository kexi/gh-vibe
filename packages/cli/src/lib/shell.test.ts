import { describe, expect, test } from "bun:test";
import {
  assertSafeShellPath,
  emitShellCommand,
  shellQuote,
} from "./shell.ts";

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
      "control or format characters",
    );
  });

  test("rejects embedded NUL", () => {
    expect(() => assertSafeShellPath("/path\0evil")).toThrow(
      "control or format characters",
    );
  });

  test("rejects ESC (used to start ANSI escapes)", () => {
    expect(() => assertSafeShellPath("/path\x1b[evil")).toThrow(
      "control or format characters",
    );
  });

  test("rejects carriage return", () => {
    expect(() => assertSafeShellPath("/path\rwith\rCR")).toThrow(
      "control or format characters",
    );
  });

  test("accepts plain Latin paths", () => {
    expect(() => assertSafeShellPath("/Users/alice/work")).not.toThrow();
  });

  // Cf = format chars. These are invisible / direction-flipping and could
  // trick a human reviewer about what they're about to `eval`.
  test("rejects path containing RLO (U+202E)", () => {
    expect(() => assertSafeShellPath("/path‮evil")).toThrow(
      "control or format characters",
    );
  });

  test("rejects path containing ZWSP (U+200B)", () => {
    expect(() => assertSafeShellPath("/path​evil")).toThrow(
      "control or format characters",
    );
  });

  test("rejects path containing NUL", () => {
    expect(() => assertSafeShellPath("/p\0ath")).toThrow(
      "control or format characters",
    );
  });

  test("rejects path containing LF", () => {
    expect(() => assertSafeShellPath("/p\nath")).toThrow(
      "control or format characters",
    );
  });
});

describe("emitShellCommand", () => {
  test("wraps the cd line in the v1 sentinel block", () => {
    const chunks: string[] = [];
    emitShellCommand((s) => chunks.push(s), "cd '/repos/feature'");
    expect(chunks.join("")).toBe(
      "# __ghvibe_v1_begin__\ncd '/repos/feature'\n# __ghvibe_v1_end__\n",
    );
  });
});
