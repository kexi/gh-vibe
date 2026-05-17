// `gh`'s statusCheckRollup entry shape varies by check kind; we read whichever
// of `conclusion / status / state` is populated and normalise to upper-case.
export type CiRollup = "success" | "pending" | "failure" | "none";

const FAILURE_STATES = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "ERROR",
]);

const PENDING_STATES = new Set([
  "PENDING",
  "QUEUED",
  "IN_PROGRESS",
  "WAITING",
  "EXPECTED",
]);

const SUCCESS_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

interface RollupEntry {
  conclusion?: string | null;
  status?: string | null;
  state?: string | null;
}

export function rollupCi(arr: readonly RollupEntry[] | null | undefined): CiRollup {
  const isEmpty = !arr || arr.length === 0;
  if (isEmpty) return "none";

  let hasPending = false;
  let successCount = 0;
  for (const entry of arr) {
    // Drop non-object entries up front: `gh` shapes vary by check kind and
    // hand-rolled test arrays can include `null` / primitives. Dereferencing
    // those without a guard would crash the renderer.
    const isObject = typeof entry === "object" && entry !== null;
    if (!isObject) continue;
    const raw = entry.conclusion ?? entry.status ?? entry.state;
    if (!raw) continue;
    const s = raw.toUpperCase();
    if (FAILURE_STATES.has(s)) return "failure";
    if (PENDING_STATES.has(s)) {
      hasPending = true;
      continue;
    }
    if (SUCCESS_STATES.has(s)) successCount++;
  }

  if (hasPending) return "pending";
  if (successCount > 0) return "success";
  return "none";
}
