export function parseStateList(
  raw: string,
): ReadonlySet<"MERGED" | "CLOSED"> {
  const trimmed = raw.trim();
  const isEmpty = trimmed.length === 0;
  if (isEmpty) {
    throw new Error("invalid --state value: must not be empty");
  }
  const tokens = trimmed.split(",").map((t) => t.trim());
  const out = new Set<"MERGED" | "CLOSED">();
  for (const token of tokens) {
    const isEmptyToken = token.length === 0;
    if (isEmptyToken) {
      throw new Error("invalid --state value: empty token");
    }
    const lower = token.toLowerCase();
    if (lower === "merged") out.add("MERGED");
    else if (lower === "closed") out.add("CLOSED");
    else throw new Error(`invalid --state value: ${token}`);
  }
  const isEmptySet = out.size === 0;
  if (isEmptySet) {
    throw new Error("invalid --state value: empty set");
  }
  return out;
}
