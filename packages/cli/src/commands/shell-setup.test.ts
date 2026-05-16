import { describe, expect, test } from "bun:test";
import {
  SHELL_SETUP_SNIPPETS,
  SUPPORTED_SHELLS,
  type ShellKind,
  detectShell,
  shellSetupCommand,
  shellSetupSnippet,
} from "./shell-setup.ts";

describe("shellSetupCommand", () => {
  test("writes the snippet for the chosen shell exactly once and returns 0", () => {
    for (const kind of SUPPORTED_SHELLS) {
      const chunks: string[] = [];
      const code = shellSetupCommand(kind, {
        writeStdout: (s) => chunks.push(s),
      });
      expect(code).toBe(0);
      expect(chunks).toEqual([shellSetupSnippet(kind)]);
    }
  });
});

describe("shellSetupSnippet: contract shared by every shell", () => {
  // The wrapper must always shell out to the real binary via the calling
  // shell's equivalent of `command gh` / `& $ghBinary.Source` — never recurse
  // through the function it just defined.
  const recurseGuard: Record<ShellKind, string> = {
    bash: "command gh",
    zsh: "command gh",
    fish: "command gh",
    pwsh: "$ghBinary.Source",
  };

  for (const kind of SUPPORTED_SHELLS) {
    describe(`${kind}`, () => {
      const snippet = shellSetupSnippet(kind);

      test("invokes the real binary without recursing through the wrapper", () => {
        expect(snippet).toContain(recurseGuard[kind]);
      });

      test("opts the binary into shell mode via GH_VIBE_SHELL=v1", () => {
        expect(snippet).toContain("GH_VIBE_SHELL");
        expect(snippet).toContain("v1");
      });

      test("only acts on output fenced by the v1 begin/end sentinels", () => {
        expect(snippet).toContain("# __ghvibe_v1_begin__");
        expect(snippet).toContain("# __ghvibe_v1_end__");
      });

      test("guards against double-loading", () => {
        expect(snippet).toContain("_GH_VIBE_SHELL_SETUP_LOADED");
      });

      test("detects an existing gh function/alias before installing", () => {
        // The exact probe differs per shell, but every snippet must emit the
        // shared warning string on the bail-out path.
        expect(snippet).toContain(
          "existing gh function/alias detected",
        );
      });
    });
  }
});

describe("shellSetupSnippet: per-shell specifics", () => {
  test("bash/zsh: only triggers wrapper behavior for the `vibe` subcommand", () => {
    expect(SHELL_SETUP_SNIPPETS.bash).toContain('[ "$1" = "vibe" ]');
    expect(SHELL_SETUP_SNIPPETS.zsh).toContain('[ "$1" = "vibe" ]');
  });

  test("fish: dispatches on $argv[1] = vibe", () => {
    expect(SHELL_SETUP_SNIPPETS.fish).toContain('"$argv[1]" = "vibe"');
  });

  test("pwsh: dispatches on $args[0] -eq 'vibe'", () => {
    expect(SHELL_SETUP_SNIPPETS.pwsh).toContain("$args[0] -eq 'vibe'");
  });

  test("bash and zsh share one snippet (POSIX-compatible)", () => {
    expect(SHELL_SETUP_SNIPPETS.bash).toBe(SHELL_SETUP_SNIPPETS.zsh);
  });
});

describe("detectShell", () => {
  test("PowerShell wins via $PSModulePath even when $SHELL is unset", () => {
    expect(detectShell({ PSModulePath: "/some/pwsh/modules" })).toBe("pwsh");
  });

  test("recognises common $SHELL basenames", () => {
    expect(detectShell({ SHELL: "/bin/bash" })).toBe("bash");
    expect(detectShell({ SHELL: "/usr/bin/zsh" })).toBe("zsh");
    expect(detectShell({ SHELL: "/opt/homebrew/bin/fish" })).toBe("fish");
    expect(detectShell({ SHELL: "/usr/local/bin/pwsh" })).toBe("pwsh");
    expect(detectShell({ SHELL: "/c/program files/powershell" })).toBe("pwsh");
  });

  test("falls back to bash when nothing matches", () => {
    expect(detectShell({})).toBe("bash");
    expect(detectShell({ SHELL: "/usr/bin/dash" })).toBe("bash");
  });
});
