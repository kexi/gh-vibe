/**
 * Emit a shell completion script for `gh vibe`.
 *
 * fish and zsh are supported; bash/pwsh are planned and the API is shaped so
 * that adding them is a matter of dropping new snippets into `SNIPPETS` and
 * expanding `COMPLETION_SUPPORTED_SHELLS`.
 *
 * Per-shell installation:
 *
 *   # fish (persistent)
 *   gh vibe completion --shell=fish > ~/.config/fish/completions/gh-vibe.fish
 *
 *   # fish (current session only)
 *   gh vibe completion --shell=fish | source
 *
 *   # zsh (persistent — make sure the dir is in $fpath and compinit has run)
 *   gh vibe completion --shell=zsh > ~/.config/zsh/completions/_gh-vibe
 *
 *   # zsh (current session only)
 *   eval "$(gh vibe completion --shell=zsh)"
 *
 * Each snippet:
 *   - guards against double-loading via `_GH_VIBE_COMPLETION_LOADED`
 *     (separate sentinel from `_GH_VIBE_SHELL_SETUP_LOADED` so users can
 *     load the two scripts independently),
 *   - registers completion under the real `gh` command (the extension is
 *     invoked as `gh vibe …`) AND under the `gh-vibe` binary directly,
 *   - completes PR / issue numbers dynamically via `gh pr list` /
 *     `gh issue list`, silencing errors with `2>/dev/null` so tabbing in a
 *     non-repo / offline directory yields no suggestions rather than noise,
 *   - caches PR / issue lookups in a per-repo tmpfile with a 30-second TTL so
 *     repeated TAB presses don't burn a `gh` round-trip each time.
 *
 * zsh-specific note: the script captures the official `_gh` completion (if
 * loaded) into `_gh_ghvibe_orig` before installing `_gh-vibe-wrapper` as the
 * `gh` completion handler. The wrapper inspects `$words[2]` and dispatches to
 * `_gh-vibe` when the user types `gh vibe …`, falling back to the saved
 * `_gh_ghvibe_orig` (or `_files`) otherwise. This means **the snippet must be
 * sourced after `eval "$(gh completion -s zsh)"`** — otherwise there is no
 * `_gh` to save, and gh's official completion will overwrite our wrapper if it
 * loads later.
 */

import { type ShellKind } from "./shell-setup.ts";

export { type ShellKind } from "./shell-setup.ts";

/**
 * Shells we can currently emit a completion snippet for. Deliberately narrower
 * than `SUPPORTED_SHELLS` from `shell-setup.ts`: bash/pwsh are not wired up
 * yet, so accepting `--shell=bash` here would silently produce nothing.
 */
export const COMPLETION_SUPPORTED_SHELLS: readonly ShellKind[] = [
  "fish",
  "zsh",
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
    set -g _GH_VIBE_COMPLETION_TTL 30

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

    # Build a per-repo cache filename. Returns empty string when not inside a
    # git repo — callers treat that as "no cache available, just go to gh".
    function __ghvibe_cache_file
        set -l kind $argv[1]
        set -l toplevel (command git rev-parse --show-toplevel 2>/dev/null)
        if test -z "$toplevel"
            echo ""
            return
        end
        set -l slug (string replace -ar '[^A-Za-z0-9]' _ -- $toplevel)
        set -l dir (set -q TMPDIR; and echo $TMPDIR; or echo /tmp)
        echo $dir/gh-vibe-completion-$USER-$kind-$slug
    end

    # Emit cached lines and return 0 on a fresh hit. mtime check supports both
    # BSD (macOS) and GNU (Linux) stat by trying -f %m then -c %Y.
    function __ghvibe_cache_get
        set -l file $argv[1]
        if test -z "$file"; or not test -f $file
            return 1
        end
        set -l mtime (stat -f %m $file 2>/dev/null; or stat -c %Y $file 2>/dev/null)
        if test -z "$mtime"
            return 1
        end
        set -l age (math (date +%s) - $mtime)
        if test $age -ge $_GH_VIBE_COMPLETION_TTL
            return 1
        end
        cat $file
        return 0
    end

    function __ghvibe_complete_prs
        set -l cache (__ghvibe_cache_file prs)
        if __ghvibe_cache_get $cache
            return
        end
        set -l result (command gh pr list --state open --limit 100 --template '{{range .}}{{.number}}\\t{{.title}}\\n{{end}}' 2>/dev/null | string collect)
        if test -z "$result"
            return
        end
        if test -n "$cache"
            printf '%s' $result > $cache 2>/dev/null
            # Cached PR titles can be sensitive on private repos; restrict to
            # the current user before the next reader touches the file.
            command chmod 600 $cache 2>/dev/null
        end
        printf '%s' $result
    end

    function __ghvibe_complete_issues
        set -l cache (__ghvibe_cache_file issues)
        if __ghvibe_cache_get $cache
            return
        end
        set -l result (command gh issue list --state open --limit 100 --template '{{range .}}{{.number}}\\t{{.title}}\\n{{end}}' 2>/dev/null | string collect)
        if test -z "$result"
            return
        end
        if test -n "$cache"
            printf '%s' $result > $cache 2>/dev/null
            # Same PII-protection rationale as __ghvibe_complete_prs.
            command chmod 600 $cache 2>/dev/null
        end
        printf '%s' $result
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
    complete -c gh -x -n '__ghvibe_using_command completion' -l shell -d 'Target shell' -a 'fish zsh'
    complete -c gh -f -n '__ghvibe_using_command completion' -s h -l help -d 'Show help for completion'
end
`;

// Zsh snippet. Same Go-template escaping rule as fish (`\\t` / `\\n` in the
// JS source becomes the literal 2-char sequences `\t` / `\n` in the emitted
// script, which Go text/template then interprets). zsh's own field splitting
// uses ANSI-C quoting like `$'\t'` which we *do* want zsh to interpret at
// runtime — those go through verbatim from this template literal.
const ZSH_SNIPPET = `#compdef gh-vibe gh
# gh-vibe completion — eval "$(gh vibe completion --shell=zsh)"
if [[ -n \${_GH_VIBE_COMPLETION_LOADED:-} ]]; then
  :
else
  _GH_VIBE_COMPLETION_LOADED=1
  _GH_VIBE_COMPLETION_TTL=30

  # Build a per-repo cache filename. Echoes empty string when not inside a
  # git repo — callers treat that as "no cache available, just hit gh".
  __ghvibe_cache_file() {
    local kind=$1
    local toplevel
    toplevel=$(command git rev-parse --show-toplevel 2>/dev/null)
    if [[ -z $toplevel ]]; then
      print -r --
      return
    fi
    local slug=\${toplevel//[^A-Za-z0-9]/_}
    local dir=\${TMPDIR:-/tmp}
    print -r -- "$dir/gh-vibe-completion-\${USER}-\${kind}-\${slug}"
  }

  # Print cached contents and return 0 on a fresh hit. mtime check supports
  # both BSD (macOS, stat -f %m) and GNU (Linux, stat -c %Y).
  __ghvibe_cache_get() {
    local file=$1
    if [[ -z $file || ! -f $file ]]; then
      return 1
    fi
    local mtime
    mtime=$(stat -f %m "$file" 2>/dev/null || stat -c %Y "$file" 2>/dev/null)
    if [[ -z $mtime ]]; then
      return 1
    fi
    local now age
    now=$(date +%s)
    age=$(( now - mtime ))
    if (( age >= _GH_VIBE_COMPLETION_TTL )); then
      return 1
    fi
    cat -- "$file"
    return 0
  }

  __ghvibe_complete_prs() {
    local cache raw
    cache=$(__ghvibe_cache_file prs)
    if ! raw=$(__ghvibe_cache_get "$cache"); then
      raw=$(command gh pr list --state open --limit 100 --template '{{range .}}{{.number}}\\t{{.title}}\\n{{end}}' 2>/dev/null)
      if [[ -n $raw && -n $cache ]]; then
        print -r -- "$raw" > "$cache" 2>/dev/null
        # Cached PR titles can be sensitive on private repos; restrict to
        # the current user before the next reader touches the file.
        command chmod 600 "$cache" 2>/dev/null
      fi
    fi
    if [[ -z $raw ]]; then
      return
    fi
    local -a items
    local num title
    # _describe uses ':' as the separator between the candidate and its
    # description, so any ':' inside the PR title would split the entry and
    # corrupt the display. Replace ':' with a space — purely cosmetic, the
    # selected value is just the PR number.
    while IFS=$'\\t' read -r num title; do
      if [[ -z $num ]]; then
        continue
      fi
      items+=("\${num}:\${title//:/ }")
    done <<< "$raw"
    _describe -t prs 'pull request' items
  }

  __ghvibe_complete_issues() {
    local cache raw
    cache=$(__ghvibe_cache_file issues)
    if ! raw=$(__ghvibe_cache_get "$cache"); then
      raw=$(command gh issue list --state open --limit 100 --template '{{range .}}{{.number}}\\t{{.title}}\\n{{end}}' 2>/dev/null)
      if [[ -n $raw && -n $cache ]]; then
        print -r -- "$raw" > "$cache" 2>/dev/null
        # Same PII-protection rationale as __ghvibe_complete_prs.
        command chmod 600 "$cache" 2>/dev/null
      fi
    fi
    if [[ -z $raw ]]; then
      return
    fi
    local -a items
    local num title
    # Same ':'-in-title sanitisation as __ghvibe_complete_prs above.
    while IFS=$'\\t' read -r num title; do
      if [[ -z $num ]]; then
        continue
      fi
      items+=("\${num}:\${title//:/ }")
    done <<< "$raw"
    _describe -t issues 'issue' items
  }

  _ghvibe_cmd_review() {
    _arguments \\
      '(-n --dry-run)'{-n,--dry-run}'[Print what would happen without creating a worktree]' \\
      '(-h --help)'{-h,--help}'[Show help for review]' \\
      '1: :__ghvibe_complete_prs'
  }

  _ghvibe_cmd_issue() {
    _arguments \\
      '(-n --dry-run)'{-n,--dry-run}'[Print derived branch + base and exit]' \\
      '--base[Base branch (default: repository default)]:base branch:' \\
      '--type[Override label-inferred type]:type:(feat fix docs chore refactor test perf)' \\
      '(-h --help)'{-h,--help}'[Show help for issue]' \\
      '1: :__ghvibe_complete_issues'
  }

  _ghvibe_cmd_list() {
    _arguments \\
      '--json[Emit machine-readable JSON]' \\
      '--stale[Show only worktrees whose PR is merged or closed]' \\
      '--limit[Cap on gh pr list query size (1-1000)]:limit:' \\
      '--allow-no-default-branch[Suppress origin/HEAD warning]' \\
      '(-h --help)'{-h,--help}'[Show help for list]'
  }

  _ghvibe_cmd_clean() {
    _arguments \\
      '(-n --dry-run)'{-n,--dry-run}'[List candidates without deleting]' \\
      '--state[Comma-separated subset of merged,closed]:state:(merged closed merged,closed)' \\
      '--include-no-pr[Also clean worktrees whose branch has no PR]' \\
      '--yes[Skip the typed-count confirmation prompt]' \\
      '--allow-no-default-branch[Proceed even when origin/HEAD is unset]' \\
      '(-h --help)'{-h,--help}'[Show help for clean]'
  }

  _ghvibe_cmd_shellsetup() {
    _arguments \\
      '--shell[Target shell]:shell:(bash zsh fish pwsh)' \\
      '(-h --help)'{-h,--help}'[Show help for shell-setup]'
  }

  _ghvibe_cmd_completion() {
    _arguments \\
      '--shell[Target shell]:shell:(fish zsh)' \\
      '(-h --help)'{-h,--help}'[Show help for completion]'
  }

  # Top-level dispatcher for the \`gh vibe …\` namespace.
  _gh-vibe() {
    local context state line
    local -a subs
    subs=(
      'review:Create a worktree for reviewing a pull request'
      'issue:Create a worktree for working on an issue'
      'list:List vibe worktrees and their PR / CI status'
      'clean:Bulk-remove worktrees whose PR is merged/closed'
      'shell-setup:Print shell wrapper that auto-cd into worktrees'
      'completion:Print a shell completion script'
    )
    _arguments -C '1: :->subcmd' '*::arg:->args'
    case $state in
      subcmd)
        _describe -t commands 'gh vibe subcommand' subs
        ;;
      args)
        case $line[1] in
          review)      _ghvibe_cmd_review ;;
          issue)       _ghvibe_cmd_issue ;;
          list)        _ghvibe_cmd_list ;;
          clean)       _ghvibe_cmd_clean ;;
          shell-setup) _ghvibe_cmd_shellsetup ;;
          completion)  _ghvibe_cmd_completion ;;
        esac
        ;;
    esac
  }

  # Wrapper installed on the real \`gh\` command. We only steal the completion
  # path when the user is actually typing \`gh vibe …\`; everything else falls
  # through to the saved official _gh (or _files as a last resort), so this
  # snippet never breaks plain \`gh pr list\` / \`gh repo view\` completion.
  _gh-vibe-wrapper() {
    if [[ \${words[2]:-} == vibe ]]; then
      shift words
      (( CURRENT-- ))
      _gh-vibe
      return
    fi
    if (( $+functions[_gh_ghvibe_orig] )); then
      _gh_ghvibe_orig
    elif (( $+functions[_gh] )); then
      _gh
    else
      _files
    fi
  }

  # Capture the official _gh (if present) BEFORE compdef-overwriting it.
  # autoload +X forces the function body to load so functions -c can copy it.
  if (( $+functions[_gh] )) && (( ! $+functions[_gh_ghvibe_orig] )); then
    autoload +X _gh 2>/dev/null
    functions -c _gh _gh_ghvibe_orig
  fi

  compdef _gh-vibe-wrapper gh
  compdef _gh-vibe gh-vibe
fi
`;

/**
 * Map of shell → snippet. `Partial` because not every `ShellKind` has a
 * snippet yet; unsupported shells are filtered out at the CLI dispatch layer
 * via `COMPLETION_SUPPORTED_SHELLS`.
 */
const SNIPPETS: Partial<Record<ShellKind, string>> = {
  fish: FISH_SNIPPET,
  zsh: ZSH_SNIPPET,
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

/**
 * Single source for the "shell isn't wired up yet" message. The CLI
 * dispatcher and the inner `completionCommand` both emit this so users see
 * the same wording regardless of which guard triggered.
 */
export function unsupportedShellMessage(shell: ShellKind): string {
  return (
    `gh-vibe: completion for ${shell} is not yet supported ` +
    `(fish and zsh only for now). ` +
    `Pass --shell=fish or --shell=zsh to emit a snippet anyway.\n`
  );
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
 * If `shell` is a valid `ShellKind` but has no snippet yet (bash/pwsh today),
 * this writes an explanatory message to stderr and returns 2. We accept the
 * unsupported shell at this layer rather than narrowing the parameter type so
 * the CLI dispatch and tests can exercise the not-yet-supported branch
 * through the same surface as the happy path — mirroring how
 * `shellSetupCommand` accepts every `ShellKind` uniformly.
 */
export function completionCommand(
  shell: ShellKind,
  deps: CompletionDeps = defaultDeps,
): number {
  const snippet = completionSnippet(shell);
  const isSupported = snippet !== undefined;
  if (!isSupported) {
    deps.writeStderr(unsupportedShellMessage(shell));
    return 2;
  }
  deps.writeStdout(snippet);
  return 0;
}

/** @internal Exposed for tests that want to introspect the canonical snippets. */
export const COMPLETION_SNIPPETS = SNIPPETS;
