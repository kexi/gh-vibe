import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHELL_SETUP_SNIPPET } from "./shell-setup.ts";

/**
 * Integration tests for the canonical shell snippet emitted by
 * `gh vibe shell-setup`. These shell out to real bash / zsh because the snippet
 * is the public contract with the user's interactive shell — no amount of
 * string-match unit testing can catch a `local` keyword that's invalid in
 * dash, or a `[[ ]]` that breaks under POSIX `sh`.
 *
 * Each test that needs a real shell uses `test.skipIf(!hasShell(...))` so CI
 * environments without bash/zsh installed simply skip instead of erroring.
 */

function hasShell(shell: string): boolean {
  const result = spawnSync(shell, ["-c", "exit 0"], { stdio: "ignore" });
  return result.status === 0;
}

const HAS_BASH = hasShell("bash");
const HAS_ZSH = hasShell("zsh");

describe("shell-setup snippet: syntax check", () => {
  // T-02: bash must parse the snippet without complaint. `bash -n` reads from
  // stdin, parses, and exits without running anything.
  test.skipIf(!HAS_BASH)("bash -n parses snippet without syntax error", () => {
    const result = spawnSync("bash", ["-n"], {
      input: SHELL_SETUP_SNIPPET,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  // T-03: same for zsh, which has its own quirks (e.g. `[ ... ]` vs `[[ ... ]]`,
  // word splitting differences in unquoted parameter expansion).
  test.skipIf(!HAS_ZSH)("zsh -n parses snippet without syntax error", () => {
    const result = spawnSync("zsh", ["-n"], {
      input: SHELL_SETUP_SNIPPET,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
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

  // T-15: After snippet eval, `gh <anything-other-than-vibe>` must be a clean
  // passthrough to the real binary — no env injection, no eval, nothing.
  test.skipIf(!HAS_BASH)(
    "non-vibe gh commands pass through to `command gh` unchanged",
    () => {
      const script = `${SHELL_SETUP_SNIPPET}\ngh pr list --foo bar\n`;
      const { stdout, status } = runBash(script);

      // Our fake gh echoes "fake-gh:<args>", proving the wrapper delegated.
      expect(stdout).toContain("fake-gh:pr list --foo bar");
      expect(status).toBe(0);
    },
  );

  // T-07: When the user already defined a `gh` function (e.g. from another
  // tool), the snippet must refuse to clobber it and must warn on stderr.
  test.skipIf(!HAS_BASH)(
    "existing gh function: warns and does not overwrite",
    () => {
      const script = `
gh() { echo "user-gh:$*"; }
${SHELL_SETUP_SNIPPET}
gh hello
printf 'LOADED=%s\\n' "\${_GH_VIBE_SHELL_SETUP_LOADED:-}"
`;
      const { stdout, stderr } = runBash(script);

      expect(stderr).toContain("existing gh function/alias detected");
      // Sentinel proves the *user's* function is still the one being called.
      expect(stdout).toContain("user-gh:hello");
      // The install path was never entered, so the load-guard stays empty.
      expect(stdout).toContain("LOADED=\n");
    },
  );

  // T-08: same contract when the conflict is an alias rather than a function.
  //
  // Note: bash performs alias expansion only when `expand_aliases` is on
  // (default for interactive shells, off for non-interactive scripts). We
  // rely on the snippet's `alias gh >/dev/null 2>&1` builtin check, which
  // detects the alias regardless of expansion. Keeping `expand_aliases` off
  // here matches how the snippet is parsed at file source-time in the user's
  // non-interactive startup path.
  test.skipIf(!HAS_BASH)(
    "existing gh alias: warns and does not overwrite",
    () => {
      const script = `
alias gh='echo aliased-gh:'
${SHELL_SETUP_SNIPPET}
# Probe: if the snippet wrongly installed its wrapper, the load-guard would be
# set. The warning path leaves it empty.
printf 'LOADED=%s\\n' "\${_GH_VIBE_SHELL_SETUP_LOADED:-}"
`;
      const { stdout, stderr } = runBash(script);

      expect(stderr).toContain("existing gh function/alias detected");
      // Snippet must NOT have set the load-guard, which only the install path
      // touches.
      expect(stdout).toContain("LOADED=\n");
    },
  );

  // T-09: sourcing the snippet a second time in the same shell session must
  // be a no-op — no warnings, no re-install, no extra side effects. This is
  // what protects users who put `eval "$(gh vibe shell-setup)"` in both
  // ~/.bashrc and ~/.bash_profile.
  test.skipIf(!HAS_BASH)(
    "second eval is a silent no-op (no warning, wrapper still works)",
    () => {
      const script = `
${SHELL_SETUP_SNIPPET}
${SHELL_SETUP_SNIPPET}
gh pr list
`;
      const { stdout, stderr, status } = runBash(script);

      // No "existing gh function/alias detected" — our own function on the
      // second pass should be caught by _GH_VIBE_SHELL_SETUP_LOADED first.
      expect(stderr).not.toContain("existing gh function/alias detected");
      expect(stdout).toContain("fake-gh:pr list");
      expect(status).toBe(0);
    },
  );
});
