import { describe, expect, test } from "bun:test";
import { parseStateList } from "./state.ts";

describe("parseStateList", () => {
  test("single token 'merged' → {MERGED}", () => {
    expect(new Set(parseStateList("merged"))).toEqual(new Set(["MERGED"]));
  });

  test("single token 'closed' → {CLOSED}", () => {
    expect(new Set(parseStateList("closed"))).toEqual(new Set(["CLOSED"]));
  });

  test("'merged,closed' → {MERGED, CLOSED}", () => {
    expect(new Set(parseStateList("merged,closed"))).toEqual(
      new Set(["MERGED", "CLOSED"]),
    );
  });

  test("'merged, closed' (whitespace after comma): {MERGED, CLOSED}", () => {
    expect(new Set(parseStateList("merged, closed"))).toEqual(
      new Set(["MERGED", "CLOSED"]),
    );
  });

  test("'  merged  ,  closed  ' (whitespace around tokens): {MERGED, CLOSED}", () => {
    expect(new Set(parseStateList("  merged  ,  closed  "))).toEqual(
      new Set(["MERGED", "CLOSED"]),
    );
  });

  test("'merged,merged,closed' (duplicates): deduped to {MERGED, CLOSED}", () => {
    expect(new Set(parseStateList("merged,merged,closed"))).toEqual(
      new Set(["MERGED", "CLOSED"]),
    );
  });

  test("'MERGED' (uppercase): {MERGED}", () => {
    expect(new Set(parseStateList("MERGED"))).toEqual(new Set(["MERGED"]));
  });

  test("'Merged' (mixed case): {MERGED}", () => {
    expect(new Set(parseStateList("Merged"))).toEqual(new Set(["MERGED"]));
  });

  test("'CLOSED,merged' (mixed case + order): {MERGED, CLOSED}", () => {
    expect(new Set(parseStateList("CLOSED,merged"))).toEqual(
      new Set(["MERGED", "CLOSED"]),
    );
  });

  test("empty string throws", () => {
    expect(() => parseStateList("")).toThrow(/must not be empty/);
  });

  test("all-whitespace string throws", () => {
    expect(() => parseStateList("   ")).toThrow(/must not be empty/);
  });

  test("empty middle token ('merged,,closed') throws 'empty token'", () => {
    expect(() => parseStateList("merged,,closed")).toThrow(/empty token/);
  });

  test("trailing empty token ('merged,') throws 'empty token'", () => {
    expect(() => parseStateList("merged,")).toThrow(/empty token/);
  });

  test("leading empty token (',merged') throws 'empty token'", () => {
    expect(() => parseStateList(",merged")).toThrow(/empty token/);
  });

  test("unknown token 'foo' throws 'invalid --state value'", () => {
    expect(() => parseStateList("foo")).toThrow(/invalid --state value: foo/);
  });

  test("mix of valid + invalid tokens throws on the invalid one", () => {
    expect(() => parseStateList("merged,foo")).toThrow(
      /invalid --state value: foo/,
    );
  });
});
