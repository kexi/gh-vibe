import { describe, expect, test } from "bun:test";
import { rollupCi } from "./ci.ts";

describe("rollupCi", () => {
  test("null input → 'none'", () => {
    expect(rollupCi(null)).toBe("none");
  });

  test("undefined input → 'none'", () => {
    expect(rollupCi(undefined)).toBe("none");
  });

  test("empty array → 'none'", () => {
    expect(rollupCi([])).toBe("none");
  });

  test("any failure-class entry → 'failure'", () => {
    expect(rollupCi([{ conclusion: "FAILURE" }])).toBe("failure");
    expect(rollupCi([{ conclusion: "CANCELLED" }])).toBe("failure");
    expect(rollupCi([{ conclusion: "TIMED_OUT" }])).toBe("failure");
    expect(rollupCi([{ conclusion: "ACTION_REQUIRED" }])).toBe("failure");
    expect(rollupCi([{ conclusion: "ERROR" }])).toBe("failure");
  });

  test("mix of pending + failure → 'failure' (failure wins)", () => {
    expect(
      rollupCi([{ status: "IN_PROGRESS" }, { conclusion: "FAILURE" }]),
    ).toBe("failure");
  });

  test("any pending-class entry, no failures → 'pending'", () => {
    expect(rollupCi([{ status: "PENDING" }])).toBe("pending");
    expect(rollupCi([{ status: "QUEUED" }])).toBe("pending");
    expect(rollupCi([{ status: "IN_PROGRESS" }])).toBe("pending");
    expect(rollupCi([{ state: "WAITING" }])).toBe("pending");
    expect(rollupCi([{ state: "EXPECTED" }])).toBe("pending");
  });

  test("all SUCCESS / NEUTRAL / SKIPPED → 'success'", () => {
    expect(
      rollupCi([
        { conclusion: "SUCCESS" },
        { conclusion: "NEUTRAL" },
        { conclusion: "SKIPPED" },
      ]),
    ).toBe("success");
  });

  test("all SKIPPED → 'success'", () => {
    expect(rollupCi([{ conclusion: "SKIPPED" }])).toBe("success");
  });

  test("unknown-only conclusions → 'none'", () => {
    expect(rollupCi([{ conclusion: "MYSTERY" }])).toBe("none");
  });

  test("lowercase inputs are normalised before comparison", () => {
    expect(rollupCi([{ conclusion: "success" }])).toBe("success");
    expect(rollupCi([{ conclusion: "failure" }])).toBe("failure");
  });

  test("conclusion takes precedence over status / state", () => {
    expect(
      rollupCi([
        { conclusion: "SUCCESS", status: "IN_PROGRESS", state: "FAILURE" },
      ]),
    ).toBe("success");
  });

  test("falls through to status when conclusion is null", () => {
    expect(
      rollupCi([{ conclusion: null, status: "IN_PROGRESS" }]),
    ).toBe("pending");
  });

  test("falls through to state when conclusion and status are null", () => {
    expect(
      rollupCi([{ conclusion: null, status: null, state: "FAILURE" }]),
    ).toBe("failure");
  });
});

describe("rollupCi: malformed input", () => {
  // Production-defensive: gh JSON shapes vary, and downstream consumers may
  // call rollupCi with hand-rolled arrays. Non-object entries (null,
  // primitives) must be skipped instead of crashing the renderer.
  test("array of only non-object entries → 'none'", () => {
    expect(rollupCi([null, undefined, {}, "x", 42, []] as any)).toBe("none");
  });

  test("mixed valid SUCCESS entry with null / undefined entries → 'success'", () => {
    expect(
      rollupCi([{ conclusion: "SUCCESS" }, null, undefined] as any),
    ).toBe("success");
  });

  test("all-null fields entry followed by FAILURE entry → 'failure'", () => {
    expect(
      rollupCi([
        { conclusion: null, status: null, state: null },
        { conclusion: "FAILURE" },
      ]),
    ).toBe("failure");
  });
});
