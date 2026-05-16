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
