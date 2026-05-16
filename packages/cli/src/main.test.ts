import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { IssueOptions } from "./commands/issue.ts";
import type { ReviewOptions } from "./commands/review.ts";
import { initShellMode, main, type MainDeps } from "./main.ts";
import { getShellMode, setShellMode } from "./lib/runtime.ts";

/**
 * Tests for `initShellMode` — the one place where `GH_VIBE_SHELL` and
 * `process.stdout.isTTY` get translated into the process-wide shell mode flag.
 *
 * These tests mutate `process.env.GH_VIBE_SHELL`, `process.stdout.isTTY`, and
 * `console.log`, so each test snapshots and restores them in `beforeEach` /
 * `afterEach` to avoid bleeding state between tests.
 */

const ORIGINAL_ENV_KEY = "GH_VIBE_SHELL";

let savedEnv: string | undefined;
let savedIsTty: unknown;
let savedConsoleLog: typeof console.log;
let stderrChunks: string[];
let stderrWriteOriginal: typeof process.stderr.write;

beforeEach(() => {
  savedEnv = process.env[ORIGINAL_ENV_KEY];
  delete process.env[ORIGINAL_ENV_KEY];

  // `process.stdout.isTTY` is a writable, configurable getter in Node/Bun; we
  // shadow it with a plain data property so individual tests can set it.
  savedIsTty = process.stdout.isTTY;

  savedConsoleLog = console.log;

  // Capture stderr without polluting test output.
  stderrChunks = [];
  stderrWriteOriginal = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[ORIGINAL_ENV_KEY];
  } else {
    process.env[ORIGINAL_ENV_KEY] = savedEnv;
  }
  Object.defineProperty(process.stdout, "isTTY", {
    value: savedIsTty,
    configurable: true,
    writable: true,
  });
  console.log = savedConsoleLog;
  process.stderr.write = stderrWriteOriginal;
  setShellMode(false);
});

function setIsTty(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
    writable: true,
  });
}

describe("initShellMode", () => {
  test("env=v1 + TTY: warns to stderr, returns false, runtime stays in normal mode", () => {
    process.env[ORIGINAL_ENV_KEY] = "v1";
    setIsTty(true);

    const result = initShellMode();
    setShellMode(result);

    expect(result).toBe(false);
    expect(getShellMode()).toBe(false);
    const stderrAll = stderrChunks.join("");
    expect(stderrAll).toContain("gh-vibe:");
    expect(stderrAll.toLowerCase()).toContain("tty");
  });

  test("env=v1 + non-TTY: returns true and runtime enters shell mode", () => {
    process.env[ORIGINAL_ENV_KEY] = "v1";
    setIsTty(false);

    const result = initShellMode();
    setShellMode(result);

    expect(result).toBe(true);
    expect(getShellMode()).toBe(true);
  });

  test("env=undefined: returns false regardless of TTY", () => {
    setIsTty(false);

    const result = initShellMode();

    expect(result).toBe(false);
  });

  test("env=v0 / unknown value: returns false (only the exact 'v1' opts in)", () => {
    process.env[ORIGINAL_ENV_KEY] = "v0";
    setIsTty(false);
    expect(initShellMode()).toBe(false);

    process.env[ORIGINAL_ENV_KEY] = "totally-bogus";
    setIsTty(false);
    expect(initShellMode()).toBe(false);
  });

  // T-28: GH_VIBE_SHELL must not leak into child processes (vibe/git/gh)
  test("GH_VIBE_SHELL is deleted from process.env after init (no leak to children)", () => {
    process.env[ORIGINAL_ENV_KEY] = "v1";
    setIsTty(false);

    initShellMode();

    expect(process.env[ORIGINAL_ENV_KEY]).toBeUndefined();
  });

  test("GH_VIBE_SHELL is also cleared when init returns false (TTY fallback)", () => {
    process.env[ORIGINAL_ENV_KEY] = "v1";
    setIsTty(true);

    initShellMode();

    expect(process.env[ORIGINAL_ENV_KEY]).toBeUndefined();
  });

  // T-29: in shell mode, console.log must redirect to stderr (via console.error)
  test("shell mode: console.log is rewired to console.error (stderr)", () => {
    process.env[ORIGINAL_ENV_KEY] = "v1";
    setIsTty(false);

    // Capture console.error before init replaces console.log with it; then
    // confirm any console.log call routes through the same sink.
    const errorCalls: unknown[][] = [];
    const consoleErrorOriginal = console.error;
    console.error = ((...args: unknown[]) => {
      errorCalls.push(args);
    }) as typeof console.error;

    try {
      initShellMode();

      // After init, console.log must be the very same function as console.error
      // — that is the contract (`console.log = console.error`).
      expect(console.log).toBe(console.error);

      console.log("from-test-marker");
    } finally {
      console.error = consoleErrorOriginal;
    }

    expect(errorCalls.length).toBe(1);
    expect(errorCalls[0]).toEqual(["from-test-marker"]);
  });

  test("normal mode (TTY fallback): console.log is NOT rewired", () => {
    process.env[ORIGINAL_ENV_KEY] = "v1";
    setIsTty(true);

    initShellMode();

    expect(console.log).toBe(savedConsoleLog);
  });
});

describe("main: issue subcommand argv parsing", () => {
  function makeMainDeps(overrides: Partial<MainDeps> = {}): MainDeps {
    return {
      issueCommand: async (_opts: IssueOptions) => 0,
      reviewCommand: async (_opts: ReviewOptions) => 0,
      ...overrides,
    };
  }

  beforeEach(() => {
    setIsTty(false);
  });

  test("--help prints usage and exits 0 without invoking issueCommand", async () => {
    let invoked = false;
    const deps = makeMainDeps({
      issueCommand: async () => {
        invoked = true;
        return 0;
      },
    });

    const code = await main(["issue", "--help"], deps);

    expect(code).toBe(0);
    expect(invoked).toBe(false);
  });

  test("no positional → exit 2", async () => {
    let invoked = false;
    const deps = makeMainDeps({
      issueCommand: async () => {
        invoked = true;
        return 0;
      },
    });

    const code = await main(["issue"], deps);

    expect(code).toBe(2);
    expect(invoked).toBe(false);
  });

  test("positional starting with '-' (e.g. -1) → exit 2", async () => {
    let invoked = false;
    const deps = makeMainDeps({
      issueCommand: async () => {
        invoked = true;
        return 0;
      },
    });

    const code = await main(["issue", "-1"], deps);

    expect(code).toBe(2);
    expect(invoked).toBe(false);
  });

  test("--base starting with '-' (e.g. -foo) → exit 2", async () => {
    let invoked = false;
    const deps = makeMainDeps({
      issueCommand: async () => {
        invoked = true;
        return 0;
      },
    });

    const code = await main(["issue", "5", "--base", "-foo"], deps);

    expect(code).toBe(2);
    expect(invoked).toBe(false);
  });

  // R6: `parseArgs` routes `--base=-foo` (equals form) through a different
  // code path than `--base -foo` (space form). Node's parser already errors
  // on dash-prefixed option values; the issue subcommand's wrapping try/catch
  // must translate that into our exit-2 contract.
  test("--base=-foo (equals form) → exit 2", async () => {
    let invoked = false;
    const deps = makeMainDeps({
      issueCommand: async () => {
        invoked = true;
        return 0;
      },
    });

    const code = await main(["issue", "5", "--base=-foo"], deps);

    expect(code).toBe(2);
    expect(invoked).toBe(false);
  });

  test("--type bogus → exit 2", async () => {
    let invoked = false;
    const deps = makeMainDeps({
      issueCommand: async () => {
        invoked = true;
        return 0;
      },
    });

    const code = await main(["issue", "5", "--type", "bogus"], deps);

    expect(code).toBe(2);
    expect(invoked).toBe(false);
  });

  test("issue 5 --type feat --base develop --dry-run forwards correct opts", async () => {
    const captured: IssueOptions[] = [];
    const deps = makeMainDeps({
      issueCommand: async (opts) => {
        captured.push(opts);
        return 0;
      },
    });

    const code = await main(
      ["issue", "5", "--type", "feat", "--base", "develop", "--dry-run"],
      deps,
    );

    expect(code).toBe(0);
    expect(captured).toEqual([
      { issueRef: "5", dryRun: true, base: "develop", type: "feat" },
    ]);
  });
});
