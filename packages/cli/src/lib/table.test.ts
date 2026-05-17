import { describe, expect, test } from "bun:test";
import { renderTable } from "./table.ts";

describe("renderTable", () => {
  test("header-only (no rows) returns just the header line", () => {
    const out = renderTable(["A", "B", "C"], []);
    expect(out).toBe("A  B  C");
  });

  test("single row aligns under each header", () => {
    const out = renderTable(["NAME", "AGE"], [["alice", "30"]]);
    const lines = out.split("\n");
    expect(lines).toEqual(["NAME   AGE", "alice  30 "]);
  });

  test("longer header than any cell still pads cells to header width", () => {
    const out = renderTable(["LONG_HEADER", "X"], [["a", "b"]]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("LONG_HEADER  X");
    expect(lines[1]).toBe("a            b");
  });

  test("longer cell than header widens the column", () => {
    const out = renderTable(["X"], [["averylongvalue"]]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("X             ");
    expect(lines[1]).toBe("averylongvalue");
  });

  test("multiple rows: each column's width is max over header + all rows", () => {
    const out = renderTable(
      ["A", "B"],
      [
        ["short", "yy"],
        ["longest-cell", "x"],
      ],
    );
    const lines = out.split("\n");
    // Column A width = max(1, 5, 12) = 12; column B width = max(1, 2, 1) = 2.
    expect(lines[0]).toBe("A             B ");
    expect(lines[1]).toBe("short         yy");
    expect(lines[2]).toBe("longest-cell  x ");
  });

  test("no trailing newline (last char is not \\n)", () => {
    const out = renderTable(["A"], [["x"]]);
    expect(out.endsWith("\n")).toBe(false);
  });

  test("ANSI / control byte in a cell is sanitised BEFORE width calc", () => {
    // SGR sequences are stripped entirely; other escape bytes (and their
    // trailing literals) get the ESC replaced with `?` by `sanitizeForLog`,
    // and remain in the cell. The width MUST be computed off the sanitised
    // string, never the raw one — otherwise an escape-padded cell would
    // visually collapse but still allocate full width.
    const out = renderTable(["A"], [["a\x1b[31mb\x1b[0m"]]);
    expect(out).not.toContain("\x1b");
    const lines = out.split("\n");
    // After stripAnsi, the SGR codes vanish; sanitised cell is "ab" (width 2).
    expect(lines[0]).toBe("A ");
    expect(lines[1]).toBe("ab");
  });

  test("NUL char in a cell is replaced with '?'", () => {
    const out = renderTable(["A"], [["a\x00b"]]);
    expect(out).not.toContain("\x00");
    expect(out).toContain("a?b");
  });

  test("U+202E (RIGHT-TO-LEFT OVERRIDE) in a cell is replaced", () => {
    const out = renderTable(["A"], [["a‮b"]]);
    expect(out).not.toContain("‮");
  });
});
