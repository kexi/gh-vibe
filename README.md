# gh-vibe

A [`gh`](https://cli.github.com/) extension that bridges GitHub PRs/issues and
[vibe](https://github.com/kexi/vibe) worktrees.

```sh
gh extension install kexi/gh-vibe
```

> The repo is currently private — `gh` will use your existing auth to install.

Full documentation: <https://gh-vibe.kexi.dev>

## Commands

### `gh vibe review <PR# | URL>`

Fetches the PR's head branch (handling fork PRs by namespacing them under
`pr/<number>/<branch>`) and creates a vibe worktree via `vibe start --reuse`.

```sh
gh vibe review 123
gh vibe review https://github.com/owner/repo/pull/123
gh vibe review 123 --dry-run
```

Requires: `gh`, `git`, `vibe` in `PATH`, run inside a git repository whose
default remote (`origin`) points at the PR's base repo.

### `gh vibe issue <# | URL>`

Looks up the issue via `gh issue view`, derives a branch name of the form
`<type>/<num>-<slug>` from the issue's labels and title (labels like `bug` →
`fix`, `enhancement` → `feat`; falls back to `chore` when no label matches),
and creates a vibe worktree off the repository's default branch via
`vibe start <branch> --base <base>`.

```sh
gh vibe issue 42
gh vibe issue 42 --type feat
gh vibe issue 42 --base develop
gh vibe issue 42 --dry-run
```

Requires: `gh`, `git`, `vibe` in `PATH`. When `--base` is omitted, the
repository must have `refs/remotes/origin/HEAD` set (recreate it with
`git remote set-head origin --auto`).

### `gh vibe list`

Lists vibe-managed worktrees (siblings of the main worktree whose basename
starts with `<repo>-`) together with their backing PR's state, CI rollup, and
review decision. One `gh pr list` call covers the whole table.

```sh
gh vibe list
gh vibe list --json                # machine-readable, no trailing newline
gh vibe list --stale               # only worktrees whose PR is merged/closed
gh vibe list --limit 500           # raise the gh pr list cap (default 200, max 1000)
```

Fork PRs are joined by `pr/<n>/<rest>`-shaped local branch names. Read-only:
no network writes, no worktree mutation. Exits with code `2` when run under
the shell wrapper (no `cd` line to emit).

### `gh vibe clean`

Bulk-removes vibe worktrees whose backing PR is merged or closed. Discovers
candidates with the same filter `gh vibe list` uses, then runs
`vibe clean -f --delete-branch` on each. Refuses to delete without an
explicit typed-count confirmation (or `--yes`), refuses to run
non-interactively without `--yes`, and refuses to run under the shell
wrapper.

```sh
gh vibe clean --dry-run     # show what would be removed, change nothing
gh vibe clean               # interactive, asks "Type N to confirm"
gh vibe clean --yes         # CI / scripted use
gh vibe clean --state=closed --include-no-pr
```

Requires: `gh`, `git`, `vibe` in `PATH`. Run from inside the main worktree.
Full documentation: <https://gh-vibe.kexi.dev/commands/clean/>.

### `gh vibe shell-setup`

Prints a shell snippet that wraps `gh` so that `gh vibe review <PR>` will
`cd` your shell into the freshly-created worktree on success.

Install once in your shell rc / profile file:

```sh
# bash / zsh — ~/.bashrc or ~/.zshrc
eval "$(gh vibe shell-setup)"

# fish — ~/.config/fish/config.fish
gh vibe shell-setup --shell=fish | source

# PowerShell — $PROFILE
gh vibe shell-setup --shell=pwsh | Out-String | Invoke-Expression
```

Without `--shell`, the calling shell is auto-detected from `$SHELL` (or
`$PSModulePath` for PowerShell).

After reloading the shell:

```sh
gh vibe review 123    # creates the worktree AND cd's you into it
```

Notes:

- Supports `bash`, `zsh`, `fish`, and PowerShell 7+ (`pwsh`).
- The wrapper detects an existing user-defined `gh` function or alias and
  refuses to install in that case (prints a warning to stderr).
- The wrapper only `eval`s output fenced with the gh-vibe v1 sentinels, so
  unrelated `gh` stdout can never be executed as shell code.
- The binary itself only emits shell commands when invoked via the wrapper
  (it looks for `GH_VIBE_SHELL=v1` in env) **and** stdout is not a TTY. If
  you set the env var manually in an interactive shell, gh-vibe falls back
  to normal mode with a warning.

### `gh vibe completion`

Prints a tab-completion script. Currently fish and zsh; bash and pwsh are
planned. Open PR / issue numbers are completed dynamically via
`gh pr list` / `gh issue list` with a 30-second per-repo cache so repeated
TAB presses don't burn a round-trip each time.

```fish
# fish — persistent
gh vibe completion --shell=fish > ~/.config/fish/completions/gh-vibe.fish

# or, current session only
gh vibe completion --shell=fish | source
```

```zsh
# zsh — persistent (load order matters: gh first, gh-vibe wrapper second, compinit last)
mkdir -p ~/.config/zsh/completions
gh vibe completion --shell=zsh > ~/.config/zsh/completions/_gh-vibe

# in ~/.zshrc
fpath=(~/.config/zsh/completions $fpath)
eval "$(gh completion -s zsh)"
autoload -U compinit && compinit

# or, current session only
eval "$(gh completion -s zsh)" && eval "$(gh vibe completion --shell=zsh)"
```

After that:

```fish
gh vibe <TAB>                # review issue list clean shell-setup completion
gh vibe review <TAB>         # open PR numbers with titles
gh vibe issue --type <TAB>   # feat fix docs chore refactor test perf
```

Without `--shell`, the calling shell is auto-detected from `$SHELL`; if the
detected shell isn't yet wired up (bash today), the command exits 2 — pass
`--shell=fish` or `--shell=zsh` explicitly to emit a snippet anyway. Full
documentation: <https://gh-vibe.kexi.dev/commands/completion/>.

## Development

This repo is a pnpm monorepo:

- `packages/cli/` — the CLI (source for the `gh-vibe` binary).
- `packages/docs/` — the Astro + Starlight documentation site.

```sh
mise install                              # node, pnpm, bun from .mise.toml
pnpm install                              # workspace deps
pnpm -C packages/cli dev review 123 --dry-run
pnpm -C packages/cli check                # tsc --noEmit
pnpm -C packages/cli test                 # bun test
pnpm -C packages/cli build                # produces ./gh-vibe at repo root
pnpm -C packages/docs dev                 # docs site at http://localhost:4321
```

## Releasing

Push a `v*` tag. The `release` workflow cross-compiles binaries for
`darwin-{arm64,amd64}`, `linux-{arm64,amd64}`, and `windows-amd64`, then
uploads them to the matching GitHub Release. `gh extension install` picks the
right asset by `<name>-<os>-<arch>[.exe]` naming.

## License

Apache-2.0
