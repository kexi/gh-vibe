{
  description = "gh-vibe — gh CLI extension bridging GitHub PRs/issues and vibe worktrees";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          # Mirrors the toolchain previously pinned in .mise.toml. flake.lock is
          # the single source of truth, so every `nix develop` user resolves to
          # identical node/pnpm/bun builds.
          packages = [
            pkgs.nodejs_24
            pkgs.pnpm_10
            pkgs.bun
          ];
        };
      }
    );
}
