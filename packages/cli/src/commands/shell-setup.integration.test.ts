import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHELL_SETUP_SNIPPETS,
  shellSetupSnippet,
} from "./shell-setup.ts";

/**
 * Integration tests for the canonical shell snippets emitted by
 * `gh vibe shell-setup`. These shell out to a real bash / zsh / fish / pwsh
 * because the snippets are the public contract with the user's interactive
 * shell — no amount of string-match unit testing can catch a `local` keyword
 * that's invalid in dash, or a `[[ ]]` that breaks under POSIX `sh`.
 *
 * Each test that needs a real shell uses `test.skipIf(!hasShell(...))` so CI
 * environments without the shell installed simply skip instead of erroring.
 */

function hasShell(shell: string, probeArgs: string[] = ["-c", "exit 0"]): boolean {
  const result = spawnSync(shell, probeArgs, { stdio: "ignore" });
  return result.status === 0;
}

const HAS_BASH = hasShell("bash");
const HAS_ZSH = hasShell("zsh");
const HAS_FISH = hasShell("fish");
const HAS_PWSH = hasShell("pwsh", ["-NoProfile", "-Command", "exit 0"]);

describe("shell-setup snippet: syntax check", () => {
  // bash must parse the bash/zsh snippet without complaint. `bash -n` reads
  // from stdin, parses, and exits without running anything.
  test.skipIf(!HAS_BASH)("bash -n parses snippet without syntax error", () => {
    const result = spawnSync("bash", ["-n"], {
      input: SHELL_SETUP_SNIPPETS.bash,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  // Same for zsh, which has its own quirks (e.g. `[ ... ]` vs `[[ ... ]]`,
  // word splitting differences in unquoted parameter expansion).
  test.skipIf(!HAS_ZSH)("zsh -n parses snippet without syntax error", () => {
    const result = spawnSync("zsh", ["-n"], {
      input: SHELL_SETUP_SNIPPETS.zsh,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  test.skipIf(!HAS_FISH)(
    "fish -n parses snippet without syntax error",
    () => {
      const result = spawnSync("fish", ["-n", "/dev/stdin"], {
        input: shellSetupSnippet("fish"),
        encoding: "utf8",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    },
  );

  // PowerShell has no `-n` flag; the cheapest parse-only check is to ask the
  // engine to tokenize the script. `[scriptblock]::Create()` will throw on
  // any parse error and succeed on valid syntax without executing the body.
  test.skipIf(!HAS_PWSH)(
    "pwsh: scriptblock parses without error",
    () => {
      const snippet = shellSetupSnippet("pwsh");
      const result = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$null = [scriptblock]::Create([Console]::In.ReadToEnd())",
        ],
        { input: snippet, encoding: "utf8" },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    },
  );
});

describe("shell-setup snippet: end-to-end behavior under real bash", () => {
  let tmpDir: string;

  beforeAll(() => {
    // Build a fake `gh` on PATH that just echoes its args. This lets us assert
    // "did the snippet's `command gh` ultimately reach the real binary?"
    // without needing a real gh install.
    tmpDir = mkdtempSync(join(tmpdir(), "gh-vibe-shellsetup-"));
    const fakeGh = join(tmpDir, "gh");
    writeFileSync(
      fakeGh,
      "#!/usr/bin/env bash\nprintf 'fake-gh:%s\\n' \"$*\"\n",
      "utf8",
    );
    chmodSync(fakeGh, 0o755);
  });

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function runBash(script: string): {
    stdout: string;
    stderr: string;
    status: number | null;
  } {
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      // Put our fake gh first so `command gh` resolves to it.
      env: {
        ...process.env,
        PATH: `${tmpDir}:${process.env.PATH ?? ""}`,
      },
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status,
    };
  }

  // After snippet eval, `gh <anything-other-than-vibe>` must be a clean
  // passthrough to the real binary — no env injection, no eval, nothing.
  test.skipIf(!HAS_BASH)(
    "non-vibe gh commands pass through to `command gh` unchanged",
    () => {
      const script = `${SHELL_SETUP_SNIPPETS.bash}\ngh pr list --foo bar\n`;
      const { stdout, status } = runBash(script);

      expect(stdout).toContain("fake-gh:pr list --foo bar");
      expect(status).toBe(0);
    },
  );

  // When the user already defined a `gh` function (e.g. from another tool),
  // the snippet must refuse to clobber it and must warn on stderr.
  test.skipIf(!HAS_BASH)(
    "existing gh function: warns and does not overwrite",
    () => {
      const script = `
gh() { echo "user-gh:$*"; }
${SHELL_SETUP_SNIPPETS.bash}
gh hello
printf 'LOADED=%s\\n' "\${_GH_VIBE_SHELL_SETUP_LOADED:-}"
`;
      const { stdout, stderr } = runBash(script);

      expect(stderr).toContain("existing gh function/alias detected");
      expect(stdout).toContain("user-gh:hello");
      expect(stdout).toContain("LOADED=\n");
    },
  );

  test.skipIf(!HAS_BASH)(
    "existing gh alias: warns and does not overwrite",
    () => {
      const script = `
alias gh='echo aliased-gh:'
${SHELL_SETUP_SNIPPETS.bash}
printf 'LOADED=%s\\n' "\${_GH_VIBE_SHELL_SETUP_LOADED:-}"
`;
      const { stdout, stderr } = runBash(script);

      expect(stderr).toContain("existing gh function/alias detected");
      expect(stdout).toContain("LOADED=\n");
    },
  );

  test.skipIf(!HAS_BASH)(
    "second eval is a silent no-op (no warning, wrapper still works)",
    () => {
      const script = `
${SHELL_SETUP_SNIPPETS.bash}
${SHELL_SETUP_SNIPPETS.bash}
gh pr list
`;
      const { stdout, stderr, status } = runBash(script);

      expect(stderr).not.toContain("existing gh function/alias detected");
      expect(stdout).toContain("fake-gh:pr list");
      expect(status).toBe(0);
    },
  );
});
