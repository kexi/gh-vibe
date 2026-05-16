# gh-vibe

A [`gh`](https://cli.github.com/) extension that bridges GitHub PRs/issues and
[vibe](https://github.com/kexi/vibe) worktrees.

```sh
gh extension install kexi/gh-vibe
```

> The repo is currently private — `gh` will use your existing auth to install.

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

### `gh vibe shell-setup`

Prints a shell snippet that wraps `gh` so that `gh vibe review <PR>` will
`cd` your shell into the freshly-created worktree on success.

Install once in your shell rc file (bash / zsh):

```sh
# ~/.bashrc or ~/.zshrc
eval "$(gh vibe shell-setup)"
```

After reloading the shell:

```sh
gh vibe review 123    # creates the worktree AND cd's you into it
```

Notes:

- Supports `bash` and `zsh`. Other shells may work but are not tested.
- The wrapper detects an existing user-defined `gh` function or alias and
  refuses to install in that case (prints a warning to stderr).
- The wrapper only `eval`s output fenced with the gh-vibe v1 sentinels, so
  unrelated `gh` stdout can never be executed as shell code.
- The binary itself only emits shell commands when invoked via the wrapper
  (it looks for `GH_VIBE_SHELL=v1` in env) **and** stdout is not a TTY. If
  you set the env var manually in an interactive shell, gh-vibe falls back
  to normal mode with a warning.

## Development

```sh
mise install         # installs bun via .mise.toml
bun install
bun run dev review 123 --dry-run
bun run check        # tsc --noEmit
bun run build        # produces ./gh-vibe (current platform)
```

## Releasing

Push a `v*` tag. The `release` workflow cross-compiles binaries for
`darwin-{arm64,amd64}`, `linux-{arm64,amd64}`, and `windows-amd64`, then
uploads them to the matching GitHub Release. `gh extension install` picks the
right asset by `<name>-<os>-<arch>[.exe]` naming.

## License

Apache-2.0
