/**
 * Emit a shell completion script for `gh vibe`.
 *
 * Currently only fish is supported; bash/zsh/pwsh are planned and the API is
 * shaped so that adding them is a matter of dropping new snippets into
 * `SNIPPETS` and expanding `COMPLETION_SUPPORTED_SHELLS`.
 *
 * Per-shell installation:
 *
 *   # fish (persistent)
 *   gh vibe completion --shell=fish > ~/.config/fish/completions/gh-vibe.fish
 *
 *   # fish (current session only)
 *   gh vibe completion --shell=fish | source
 *
 * Each snippet:
 *   - guards against double-loading via `_GH_VIBE_COMPLETION_LOADED`
 *     (separate sentinel from `_GH_VIBE_SHELL_SETUP_LOADED` so users can
 *     load the two scripts independently),
 *   - registers `complete -c gh` rules so suggestions appear under the real
 *     `gh` command (the extension is invoked as `gh vibe …`),
 *   - completes PR / issue numbers dynamically via `gh pr list` /
 *     `gh issue list`, silencing errors with `2>/dev/null` so tabbing in a
 *     non-repo / offline directory yields no suggestions rather than noise.
 */

import { type ShellKind } from "./shell-setup.ts";

export { type ShellKind } from "./shell-setup.ts";

/**
 * Shells we can currently emit a completion snippet for. Deliberately narrower
 * than `SUPPORTED_SHELLS` from `shell-setup.ts`: bash/zsh/pwsh are not wired
 * up yet, so accepting `--shell=zsh` here would silently produce nothing.
 */
export const COMPLETION_SUPPORTED_SHELLS: readonly ShellKind[] = [
  "fish",
] as const;

// Fish snippet. Note on escaping: the `gh ... --template '...'` literal uses
// Go text/template, which interprets `\t` and `\n` itself. We therefore want
// the emitted fish script to contain the literal two-character sequences
// `\t` and `\n` (not real tab/newline bytes), so inside this JS template
// literal we write them as `\\t` and `\\n`.
const FISH_SNIPPET = `# gh-vibe completion — gh vibe completion --shell=fish | source
if set -q _GH_VIBE_COMPLETION_LOADED
    # already loaded
else
    set -g _GH_VIBE_COMPLETION_LOADED 1

    function __ghvibe_needs_command
        set -l tokens (commandline -opc)
        if test (count $tokens) -eq 2; and test "$tokens[1]" = "gh"; and test "$tokens[2]" = "vibe"
            return 0
        end
        return 1
    end

    function __ghvibe_using_command
        set -l sub $argv[1]
        set -l tokens (commandline -opc)
        if test (count $tokens) -ge 3; and test "$tokens[1]" = "gh"; and test "$tokens[2]" = "vibe"; and test "$tokens[3]" = "$sub"
            return 0
        end
        return 1
    end

    function __ghvibe_needs_positional_1
        set -l sub $argv[1]
        if not __ghvibe_using_command $sub
            return 1
        end
        set -l tokens (commandline -opc)
        # tokens: gh vibe <sub> [args...]; positional #1 is unfilled when
        # every token past index 3 starts with '-'.
        set -l i 4
        while test $i -le (count $tokens)
            if not string match -q -- '-*' $tokens[$i]
                return 1
            end
            set i (math $i + 1)
        end
        return 0
    end

    function __ghvibe_complete_prs
        command gh pr list --state open --limit 100 --template '{{range .}}{{.number}}\\t{{.title}}\\n{{end}}' 2>/dev/null
    end

    function __ghvibe_complete_issues
        command gh issue list --state open --limit 100 --template '{{range .}}{{.number}}\\t{{.title}}\\n{{end}}' 2>/dev/null
    end

    # Subcommands (only when no subcommand has been typed yet)
    complete -c gh -f -n '__ghvibe_needs_command' -a 'review' -d 'Create a worktree for reviewing a pull request'
    complete -c gh -f -n '__ghvibe_needs_command' -a 'issue' -d 'Create a worktree for working on an issue'
    complete -c gh -f -n '__ghvibe_needs_command' -a 'list' -d 'List vibe worktrees and their PR / CI status'
    complete -c gh -f -n '__ghvibe_needs_command' -a 'clean' -d 'Bulk-remove worktrees whose PR is merged/closed'
    complete -c gh -f -n '__ghvibe_needs_command' -a 'shell-setup' -d 'Print shell wrapper that auto-cd''s into worktrees'
    complete -c gh -f -n '__ghvibe_needs_command' -a 'completion' -d 'Print a shell completion script'

    # review
    complete -c gh -f -n '__ghvibe_using_command review' -s n -l dry-run -d 'Print what would happen without creating a worktree'
    complete -c gh -f -n '__ghvibe_using_command review' -s h -l help -d 'Show help for review'
    complete -c gh -f -n '__ghvibe_needs_positional_1 review' -a '(__ghvibe_complete_prs)'

    # issue
    complete -c gh -f -n '__ghvibe_using_command issue' -s n -l dry-run -d 'Print derived branch + base and exit'
    complete -c gh -x -n '__ghvibe_using_command issue' -l base -d 'Base branch (default: repository default)'
    complete -c gh -x -n '__ghvibe_using_command issue' -l type -d 'Override label-inferred type' -a 'feat fix docs chore refactor test perf'
    complete -c gh -f -n '__ghvibe_using_command issue' -s h -l help -d 'Show help for issue'
    complete -c gh -f -n '__ghvibe_needs_positional_1 issue' -a '(__ghvibe_complete_issues)'

    # list
    complete -c gh -f -n '__ghvibe_using_command list' -l json -d 'Emit machine-readable JSON'
    complete -c gh -f -n '__ghvibe_using_command list' -l stale -d 'Show only worktrees whose PR is merged or closed'
    complete -c gh -x -n '__ghvibe_using_command list' -l limit -d 'Cap on gh pr list query size (1-1000)'
    complete -c gh -f -n '__ghvibe_using_command list' -l allow-no-default-branch -d 'Suppress origin/HEAD warning'
    complete -c gh -f -n '__ghvibe_using_command list' -s h -l help -d 'Show help for list'

    # clean
    complete -c gh -f -n '__ghvibe_using_command clean' -s n -l dry-run -d 'List candidates without deleting'
    complete -c gh -x -n '__ghvibe_using_command clean' -l state -d 'Comma-separated subset of merged,closed' -a 'merged closed merged,closed'
    complete -c gh -f -n '__ghvibe_using_command clean' -l include-no-pr -d 'Also clean worktrees whose branch has no PR'
    complete -c gh -f -n '__ghvibe_using_command clean' -l yes -d 'Skip the typed-count confirmation prompt'
    complete -c gh -f -n '__ghvibe_using_command clean' -l allow-no-default-branch -d 'Proceed even when origin/HEAD is unset'
    complete -c gh -f -n '__ghvibe_using_command clean' -s h -l help -d 'Show help for clean'

    # shell-setup
    complete -c gh -x -n '__ghvibe_using_command shell-setup' -l shell -d 'Target shell' -a 'bash zsh fish pwsh'
    complete -c gh -f -n '__ghvibe_using_command shell-setup' -s h -l help -d 'Show help for shell-setup'

    # completion
    complete -c gh -x -n '__ghvibe_using_command completion' -l shell -d 'Target shell' -a 'fish'
    complete -c gh -f -n '__ghvibe_using_command completion' -s h -l help -d 'Show help for completion'
end
`;

/**
 * Map of shell → snippet. `Partial` because only fish is wired up today;
 * unsupported shells are filtered out at the CLI dispatch layer via
 * `COMPLETION_SUPPORTED_SHELLS`.
 */
const SNIPPETS: Partial<Record<ShellKind, string>> = {
  fish: FISH_SNIPPET,
};

/**
 * Returns the completion snippet for `kind`, or `undefined` if no snippet is
 * available yet. Callers in the CLI dispatcher should gate on
 * `COMPLETION_SUPPORTED_SHELLS` before calling this, but the `undefined`
 * branch makes the function safe to call directly.
 */
export function completionSnippet(kind: ShellKind): string | undefined {
  return SNIPPETS[kind];
}

export interface CompletionDeps {
  /** Defaults to writing to the real stdout. */
  writeStdout: (s: string) => void;
  /** Defaults to writing to the real stderr. */
  writeStderr: (s: string) => void;
}

const defaultDeps: CompletionDeps = {
  writeStdout: (s) => {
    process.stdout.write(s);
  },
  writeStderr: (s) => {
    process.stderr.write(s);
  },
};

/**
 * Print the completion snippet for `shell` to stdout. Returns 0 on success.
 *
 * If `shell` is a valid `ShellKind` but has no snippet yet (bash/zsh/pwsh
 * today), this writes an explanatory message to stderr and returns 2. We
 * accept the unsupported shell at this layer rather than narrowing the
 * parameter type so the CLI dispatch and tests can exercise the
 * not-yet-supported branch through the same surface as the happy path —
 * mirroring how `shellSetupCommand` accepts every `ShellKind` uniformly.
 */
export function completionCommand(
  shell: ShellKind,
  deps: CompletionDeps = defaultDeps,
): number {
  const snippet = completionSnippet(shell);
  const isSupported = snippet !== undefined;
  if (!isSupported) {
    deps.writeStderr(
      `gh-vibe: completion for ${shell} is not yet supported ` +
        `(only fish for now). Pass --shell=fish to emit it anyway.\n`,
    );
    return 2;
  }
  deps.writeStdout(snippet);
  return 0;
}

/** @internal Exposed for tests that want to introspect the canonical snippets. */
export const COMPLETION_SNIPPETS = SNIPPETS;
