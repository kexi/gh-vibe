import { sanitizeForLog } from "./format.ts";

// Cells are sanitised BEFORE width calculation so an ANSI escape or bidi
// override in a branch / path can't visually widen the column nor corrupt the
// user's terminal. No trailing newline — callers append `\n` if they want one.
export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const cleanHeaders = headers.map(sanitizeForLog);
  const cleanRows = rows.map((row) => row.map(sanitizeForLog));

  const widths = cleanHeaders.map((h, i) => {
    const cellsAt = cleanRows.map((r) => r[i] ?? "");
    const longest = cellsAt.reduce(
      (max, cell) => Math.max(max, cell.length),
      h.length,
    );
    return longest;
  });

  const formatRow = (row: readonly string[]): string =>
    row.map((cell, i) => cell.padEnd(widths[i])).join("  ");

  const lines = [formatRow(cleanHeaders), ...cleanRows.map(formatRow)];
  return lines.join("\n");
}
