import { describe, expect, test } from "bun:test";
import {
  COMPLETION_SNIPPETS,
  COMPLETION_SUPPORTED_SHELLS,
  completionCommand,
  completionSnippet,
  unsupportedShellMessage,
} from "./completion.ts";

describe("completionCommand", () => {
  test("writes the snippet for each supported shell exactly once and returns 0", () => {
    for (const kind of COMPLETION_SUPPORTED_SHELLS) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = completionCommand(kind, {
        writeStdout: (s) => stdout.push(s),
        writeStderr: (s) => stderr.push(s),
      });
      expect(code).toBe(0);
      expect(stdout).toEqual([completionSnippet(kind) ?? ""]);
      expect(stderr).toEqual([]);
    }
  });

  // We deliberately accept every ShellKind at the function boundary (rather
  // than narrowing the parameter type) so the unsupported branch is reachable
  // from tests and from the CLI dispatcher through the same surface as the
  // happy path. The dispatcher additionally validates --shell against
  // COMPLETION_SUPPORTED_SHELLS, so this branch is a defense-in-depth check.
  test("returns 2 and writes to stderr for a not-yet-supported shell", () => {
    for (const kind of ["bash", "zsh", "pwsh"] as const) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = completionCommand(kind, {
        writeStdout: (s) => stdout.push(s),
        writeStderr: (s) => stderr.push(s),
      });
      expect(code).toBe(2);
      expect(stdout).toEqual([]);
      expect(stderr.length).toBe(1);
      expect(stderr[0]).toContain(`completion for ${kind} is not yet supported`);
      expect(stderr[0]).toContain("--shell=fish");
    }
  });
});

describe("completionSnippet: fish", () => {
  const snippet = completionSnippet("fish") ?? "";

  test("is non-empty", () => {
    expect(snippet.length).toBeGreaterThan(0);
  });

  test("guards against double-loading via its own sentinel", () => {
    expect(snippet).toContain("_GH_VIBE_COMPLETION_LOADED");
    // Must be a different sentinel from shell-setup so the two scripts can
    // be loaded independently without one masking the other.
    expect(snippet).not.toContain("_GH_VIBE_SHELL_SETUP_LOADED");
  });

  test("registers completions on the real `gh` command", () => {
    expect(snippet).toContain("complete -c gh");
  });

  test("lists every `gh vibe` subcommand", () => {
    for (const sub of [
      "review",
      "issue",
      "list",
      "clean",
      "shell-setup",
      "completion",
    ]) {
      // Each subcommand appears at least once as a completion candidate.
      expect(snippet).toContain(`-a '${sub}'`);
    }
  });

  test("lists every documented long flag", () => {
    for (const flag of [
      "--dry-run",
      "--base",
      "--type",
      "--json",
      "--stale",
      "--limit",
      "--allow-no-default-branch",
      "--include-no-pr",
      "--yes",
      "--state",
      "--shell",
    ]) {
      // Fish `complete` uses `-l <name>` (without the leading dashes) to
      // declare a long flag; that's the canonical form to assert on.
      const longName = flag.slice(2);
      expect(snippet).toContain(`-l ${longName}`);
    }
  });

  test("offers the full --type enum", () => {
    for (const t of ["feat", "fix", "docs", "chore", "refactor", "test", "perf"]) {
      expect(snippet).toContain(t);
    }
    // And asserts they appear together on the --type completion line, not
    // just incidentally somewhere else in the script.
    expect(snippet).toContain(
      "'feat fix docs chore refactor test perf'",
    );
  });

  test("offers the --state enum for clean", () => {
    expect(snippet).toContain("'merged closed merged,closed'");
  });

  test("offers the --shell enum for shell-setup and completion", () => {
    expect(snippet).toContain("'bash zsh fish pwsh'");
    // The `completion` subcommand only offers `fish` for now.
    expect(snippet).toMatch(/completion'.*-l shell.*-a 'fish'/s);
  });

  test("dynamically completes PR numbers via gh pr list", () => {
    expect(snippet).toContain("__ghvibe_complete_prs");
    expect(snippet).toContain("gh pr list");
  });

  test("dynamically completes issue numbers via gh issue list", () => {
    expect(snippet).toContain("__ghvibe_complete_issues");
    expect(snippet).toContain("gh issue list");
  });

  test("silences errors from dynamic lookups", () => {
    // Both helpers must redirect stderr to /dev/null so tabbing in a
    // non-repo / offline directory doesn't spam the terminal. We match on
    // `command gh pr/issue list` (the invocation form) rather than a bare
    // `gh pr list` substring so we don't accidentally pick up unrelated
    // description strings elsewhere in the script.
    const lines = snippet
      .split("\n")
      .filter(
        (l) =>
          l.includes("command gh pr list") ||
          l.includes("command gh issue list"),
      );
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line).toContain("2>/dev/null");
    }
  });

  test("caches dynamic lookups with a TTL keyed by repo toplevel", () => {
    // Both completion helpers route through __ghvibe_cache_get / _file so
    // back-to-back TAB presses don't burn a `gh` round-trip each time.
    expect(snippet).toContain("__ghvibe_cache_file");
    expect(snippet).toContain("__ghvibe_cache_get");
    expect(snippet).toContain("_GH_VIBE_COMPLETION_TTL");
    expect(snippet).toContain("set -g _GH_VIBE_COMPLETION_TTL 30");
    // Per-repo key: cache filenames must include the git toplevel so two
    // checkouts of different repos don't share suggestions.
    expect(snippet).toContain("git rev-parse --show-toplevel");
    // Cross-platform stat: BSD (-f %m) tried first, GNU (-c %Y) fallback.
    expect(snippet).toContain("stat -f %m");
    expect(snippet).toContain("stat -c %Y");
  });

  test("emits literal \\t / \\n in the gh --template (for Go text/template)", () => {
    // The fish script must hand `gh` a template whose escapes are the
    // two-character sequences \t / \n; Go text/template interprets them.
    // If we accidentally interpolated real tab/newline bytes here, the gh
    // call would explode.
    expect(snippet).toContain(
      "'{{range .}}{{.number}}\\t{{.title}}\\n{{end}}'",
    );
  });
});

describe("COMPLETION_SUPPORTED_SHELLS", () => {
  test("only contains fish for now", () => {
    expect([...COMPLETION_SUPPORTED_SHELLS]).toEqual(["fish"]);
  });

  test("every supported shell has a snippet", () => {
    for (const kind of COMPLETION_SUPPORTED_SHELLS) {
      expect(COMPLETION_SNIPPETS[kind]).toBeDefined();
    }
  });
});

describe("unsupportedShellMessage", () => {
  // Shared between the CLI dispatcher and completionCommand so users see the
  // same text regardless of which guard triggered. If this contract ever
  // drifts (e.g., a fish-only ship adds new wording in only one call site),
  // these assertions will catch it before release.
  test("names the shell and recommends --shell=fish", () => {
    for (const kind of ["bash", "zsh", "pwsh"] as const) {
      const msg = unsupportedShellMessage(kind);
      expect(msg).toContain(`completion for ${kind} is not yet supported`);
      expect(msg).toContain("--shell=fish");
      expect(msg.endsWith("\n")).toBe(true);
    }
  });

  test("is what completionCommand emits to stderr", () => {
    const stderr: string[] = [];
    completionCommand("zsh", {
      writeStdout: () => undefined,
      writeStderr: (s) => stderr.push(s),
    });
    expect(stderr).toEqual([unsupportedShellMessage("zsh")]);
  });
});
