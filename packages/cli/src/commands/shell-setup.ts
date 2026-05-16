/**
 * Emit the shell snippet that wraps `gh` so that `gh vibe <cmd>` can ask the
 * shell to `cd` into a worktree after the binary exits.
 *
 * Per-shell installation:
 *
 *   # bash / zsh
 *   eval "$(gh vibe shell-setup)"
 *
 *   # fish
 *   gh vibe shell-setup --shell=fish | source
 *
 *   # PowerShell (pwsh)
 *   gh vibe shell-setup --shell=pwsh | Out-String | Invoke-Expression
 *
 * Each snippet:
 *   - guards against double-loading via `_GH_VIBE_SHELL_SETUP_LOADED`,
 *   - refuses to install when an existing `gh` function/alias is detected,
 *   - sets `GH_VIBE_SHELL=v1` before invoking the binary so it knows the
 *     calling shell is wrapper-aware (and only then),
 *   - only eval's captured stdout when it is fenced by the magic begin/end
 *     sentinels we emit ourselves (`# __ghvibe_v1_begin__` … `# __ghvibe_v1_end__`),
 *     so unrelated stdout (e.g. from a future non-shell subcommand) can never
 *     be executed as shell code. The sentinels are `#` comments so the same
 *     emitted block is syntactically valid across all four shells.
 */

export type ShellKind = "bash" | "zsh" | "fish" | "pwsh";

export const SUPPORTED_SHELLS: readonly ShellKind[] = [
  "bash",
  "zsh",
  "fish",
  "pwsh",
] as const;

const BASH_ZSH_SNIPPET = `# gh-vibe shell integration — eval "$(gh vibe shell-setup)"
if [ -n "\${_GH_VIBE_SHELL_SETUP_LOADED:-}" ]; then
  :
else
  if [ "$(type gh 2>/dev/null | head -n1)" = "gh is a function" ] || alias gh >/dev/null 2>&1; then
    printf 'gh-vibe: existing gh function/alias detected; skipping shell-setup\\n' >&2
  else
    _GH_VIBE_SHELL_SETUP_LOADED=1
    gh() {
      if [ "$1" = "vibe" ]; then
        local __ghvibe_out __ghvibe_status
        __ghvibe_out=$(GH_VIBE_SHELL=v1 command gh "$@")
        __ghvibe_status=$?
        if [ $__ghvibe_status -eq 0 ]; then
          case "$__ghvibe_out" in
            *"# __ghvibe_v1_begin__"*"# __ghvibe_v1_end__"*)
              eval "$__ghvibe_out"
              ;;
            *)
              [ -n "$__ghvibe_out" ] && printf '%s' "$__ghvibe_out"
              ;;
          esac
        fi
        return $__ghvibe_status
      fi
      command gh "$@"
    }
  fi
fi
`;

const FISH_SNIPPET = `# gh-vibe shell integration — gh vibe shell-setup --shell=fish | source
if set -q _GH_VIBE_SHELL_SETUP_LOADED
    # already loaded
else if functions -q gh
    printf 'gh-vibe: existing gh function/alias detected; skipping shell-setup\\n' >&2
else
    set -g _GH_VIBE_SHELL_SETUP_LOADED 1
    function gh
        if test (count $argv) -gt 0; and test "$argv[1]" = "vibe"
            set -l __ghvibe_out (env GH_VIBE_SHELL=v1 command gh $argv | string collect)
            set -l __ghvibe_status $status
            if test $__ghvibe_status -eq 0
                if string match -q '*# __ghvibe_v1_begin__*# __ghvibe_v1_end__*' -- "$__ghvibe_out"
                    eval "$__ghvibe_out"
                else if test -n "$__ghvibe_out"
                    printf '%s' "$__ghvibe_out"
                end
            end
            return $__ghvibe_status
        end
        command gh $argv
    end
end
`;

const PWSH_SNIPPET = `# gh-vibe shell integration — gh vibe shell-setup --shell=pwsh | Out-String | Invoke-Expression
if ($Global:_GH_VIBE_SHELL_SETUP_LOADED) {
    # already loaded
} elseif (Get-Command -Name gh -CommandType Function,Alias -ErrorAction SilentlyContinue) {
    [Console]::Error.WriteLine('gh-vibe: existing gh function/alias detected; skipping shell-setup')
} else {
    $Global:_GH_VIBE_SHELL_SETUP_LOADED = $true
    function global:gh {
        $ghBinary = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $ghBinary) {
            [Console]::Error.WriteLine('gh-vibe: gh binary not found on PATH')
            return 1
        }
        if ($args.Count -gt 0 -and $args[0] -eq 'vibe') {
            $env:GH_VIBE_SHELL = 'v1'
            try {
                $__ghvibe_out = & $ghBinary.Source @args | Out-String
                $__ghvibe_status = $LASTEXITCODE
            } finally {
                Remove-Item Env:GH_VIBE_SHELL -ErrorAction SilentlyContinue
            }
            if ($__ghvibe_status -eq 0) {
                if ($__ghvibe_out -match '# __ghvibe_v1_begin__[\\s\\S]*# __ghvibe_v1_end__') {
                    Invoke-Expression $__ghvibe_out
                } elseif ($__ghvibe_out) {
                    [Console]::Out.Write($__ghvibe_out)
                }
            }
            return $__ghvibe_status
        }
        & $ghBinary.Source @args
    }
}
`;

const SNIPPETS: Record<ShellKind, string> = {
  bash: BASH_ZSH_SNIPPET,
  zsh: BASH_ZSH_SNIPPET,
  fish: FISH_SNIPPET,
  pwsh: PWSH_SNIPPET,
};

export function shellSetupSnippet(kind: ShellKind): string {
  return SNIPPETS[kind];
}

/**
 * Best-effort shell autodetection from environment variables. Falls back to
 * `bash` when we cannot tell — it is the safest default for the `eval "$(...)"`
 * idiom and is widely available even when `$SHELL` is unset (CI, sub-shells).
 *
 * The detection looks at:
 *   - `$SHELL` basename (`/usr/bin/zsh` → `zsh`, `/opt/homebrew/bin/fish` → `fish`)
 *   - `$PSModulePath` as a positive signal for PowerShell (set by every pwsh
 *     session even when `$SHELL` is unset)
 */
export function detectShell(env: NodeJS.ProcessEnv = process.env): ShellKind {
  const isPwsh = typeof env.PSModulePath === "string" && env.PSModulePath !== "";
  if (isPwsh) return "pwsh";

  const shellPath = env.SHELL ?? "";
  const basename = shellPath.split("/").pop()?.toLowerCase() ?? "";
  if (basename === "zsh") return "zsh";
  if (basename === "fish") return "fish";
  if (basename === "pwsh" || basename === "powershell") return "pwsh";
  return "bash";
}

export interface ShellSetupDeps {
  /** Defaults to writing to the real stdout. */
  writeStdout: (s: string) => void;
}

const defaultDeps: ShellSetupDeps = {
  writeStdout: (s) => {
    process.stdout.write(s);
  },
};

export function shellSetupCommand(
  shell: ShellKind,
  deps: ShellSetupDeps = defaultDeps,
): number {
  deps.writeStdout(shellSetupSnippet(shell));
  return 0;
}

/** @internal Exposed for tests that want to introspect the canonical snippets. */
export const SHELL_SETUP_SNIPPETS = SNIPPETS;
