/**
 * Emit the shell snippet that wraps `gh` so that `gh vibe <cmd>` can ask the
 * shell to `cd` into a worktree after the binary exits. Intended use:
 *
 *   # bash / zsh
 *   eval "$(gh vibe shell-setup)"
 *
 * The snippet:
 *   - guards against double-loading via `_GH_VIBE_SHELL_SETUP_LOADED`,
 *   - refuses to install when an existing `gh` function/alias is detected,
 *   - sets `GH_VIBE_SHELL=v1` before invoking the binary so it knows the
 *     calling shell is wrapper-aware (and only then),
 *   - only `eval`s captured stdout when it is fenced by the magic begin/end
 *     sentinels we emit ourselves, so unrelated stdout (e.g. from a future
 *     non-shell subcommand) can never be executed as shell code.
 */
const SHELL_SNIPPET = `# gh-vibe shell integration — eval "$(gh vibe shell-setup)"
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
            *": __ghvibe_v1_begin__"*": __ghvibe_v1_end__"*)
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
  deps: ShellSetupDeps = defaultDeps,
): number {
  deps.writeStdout(SHELL_SNIPPET);
  return 0;
}

/** @internal Exposed for tests that want to introspect the canonical snippet. */
export const SHELL_SETUP_SNIPPET = SHELL_SNIPPET;
