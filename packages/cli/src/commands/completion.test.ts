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
    for (const kind of ["bash", "pwsh"] as const) {
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
      // Message must name at least one currently-supported alternative.
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
    // The `completion` subcommand now offers fish *and* zsh.
    expect(snippet).toMatch(/completion'.*-l shell.*-a 'fish zsh'/s);
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

  test("restricts the on-disk cache to the current user (chmod 600)", () => {
    // Cached PR/issue titles may contain PII on private repos. The cache file
    // lives in $TMPDIR which is shared, so we explicitly tighten the mode
    // right after writing. Two occurrences expected: one in __ghvibe_complete_prs
    // and one in __ghvibe_complete_issues.
    const occurrences = snippet.split("command chmod 600").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
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

describe("completionSnippet: zsh", () => {
  const snippet = completionSnippet("zsh") ?? "";

  test("is non-empty", () => {
    expect(snippet.length).toBeGreaterThan(0);
  });

  test("guards against double-loading via its own sentinel", () => {
    expect(snippet).toContain("_GH_VIBE_COMPLETION_LOADED");
    // Must be a different sentinel from shell-setup so the two scripts can
    // be loaded independently without one masking the other.
    expect(snippet).not.toContain("_GH_VIBE_SHELL_SETUP_LOADED");
  });

  test("registers compdef on both `gh` (via wrapper) and `gh-vibe`", () => {
    // The wrapper hooks `gh` so `gh vibe …` gets our completions while
    // non-vibe `gh` subcommands fall through to the saved official _gh.
    expect(snippet).toContain("compdef _gh-vibe-wrapper gh");
    // Direct invocation of the binary should also get completion.
    expect(snippet).toContain("compdef _gh-vibe gh-vibe");
  });

  test("preserves the official _gh by copying it before compdef overwrites", () => {
    // If the user has gh's official zsh completion loaded, our snippet must
    // copy it aside into _gh_ghvibe_orig before installing our wrapper, so
    // the wrapper can fall through to the original for non-vibe gh args.
    expect(snippet).toContain("functions -c _gh _gh_ghvibe_orig");
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
      // Each subcommand name should appear in the _describe subs array.
      expect(snippet).toContain(sub);
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
      // zsh's `_arguments` declares long flags with the full `--name` form.
      expect(snippet).toContain(flag);
    }
  });

  test("offers the full --type enum on the --type _arguments line", () => {
    for (const t of ["feat", "fix", "docs", "chore", "refactor", "test", "perf"]) {
      expect(snippet).toContain(t);
    }
    // _arguments enums use the `:state:(a b c)` form.
    expect(snippet).toContain("(feat fix docs chore refactor test perf)");
  });

  test("offers the --state enum for clean", () => {
    expect(snippet).toContain("(merged closed merged,closed)");
  });

  test("offers the --shell enum for shell-setup", () => {
    expect(snippet).toContain("(bash zsh fish pwsh)");
  });

  test("offers the --shell enum for completion (fish and zsh)", () => {
    // One more entry than the fish version, because zsh shipping means the
    // completion subcommand now has two supported targets.
    expect(snippet).toContain("(fish zsh)");
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
    // non-repo / offline directory doesn't spam the terminal.
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
    expect(snippet).toContain("__ghvibe_cache_file");
    expect(snippet).toContain("__ghvibe_cache_get");
    expect(snippet).toContain("_GH_VIBE_COMPLETION_TTL");
    // zsh uses bare assignment syntax (no `set -g` prefix like fish).
    expect(snippet).toContain("_GH_VIBE_COMPLETION_TTL=30");
    // Per-repo key: cache filenames must include the git toplevel so two
    // checkouts of different repos don't share suggestions.
    expect(snippet).toContain("git rev-parse --show-toplevel");
    // Cross-platform stat: BSD (-f %m) tried first, GNU (-c %Y) fallback.
    expect(snippet).toContain("stat -f %m");
    expect(snippet).toContain("stat -c %Y");
  });

  test("restricts the on-disk cache to the current user (chmod 600)", () => {
    // Symmetric with the fish snippet — cached titles can contain PII on
    // private repos, and $TMPDIR is shared, so we tighten the mode right
    // after writing. Two occurrences expected (PR helper + issue helper).
    const occurrences = snippet.split("command chmod 600").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  test("emits literal \\t / \\n in the gh --template (for Go text/template)", () => {
    expect(snippet).toContain(
      "'{{range .}}{{.number}}\\t{{.title}}\\n{{end}}'",
    );
  });

  test("sanitises ':' inside PR / issue titles before handing to _describe", () => {
    // _describe parses `value:description` and gets confused by a stray ':'
    // inside the description. Regression guard: if this gets refactored out
    // the displayed titles will silently truncate at the first colon.
    expect(snippet).toContain("${title//:/ }");
  });
});

describe("COMPLETION_SUPPORTED_SHELLS", () => {
  test("contains fish and zsh", () => {
    expect([...COMPLETION_SUPPORTED_SHELLS]).toEqual(["fish", "zsh"]);
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
  test("names the shell and recommends a supported alternative", () => {
    for (const kind of ["bash", "pwsh"] as const) {
      const msg = unsupportedShellMessage(kind);
      expect(msg).toContain(`completion for ${kind} is not yet supported`);
      // Should mention at least one currently-supported target.
      expect(msg).toContain("--shell=fish");
      expect(msg).toContain("--shell=zsh");
      expect(msg.endsWith("\n")).toBe(true);
    }
  });

  test("is what completionCommand emits to stderr", () => {
    const stderr: string[] = [];
    completionCommand("bash", {
      writeStdout: () => undefined,
      writeStderr: (s) => stderr.push(s),
    });
    expect(stderr).toEqual([unsupportedShellMessage("bash")]);
  });
});
