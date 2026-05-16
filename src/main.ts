import { parseArgs } from "node:util";
import { reviewCommand } from "./commands/review.ts";
import { shellSetupCommand } from "./commands/shell-setup.ts";
import { setShellMode } from "./lib/runtime.ts";

const VERSION = "0.0.1";

const HELP_TEXT = `gh-vibe — gh CLI extension for vibe worktrees

Usage:
  gh vibe review <PR# | URL>   Create a worktree for reviewing a pull request
  gh vibe shell-setup          Print shell wrapper that auto-cd's into the worktree

Options:
  -n, --dry-run    Print what would happen without fetching or creating a worktree
  -h, --help       Show this help
  -v, --version    Show version

Shell integration:
  Add the following to ~/.bashrc or ~/.zshrc:
      eval "$(gh vibe shell-setup)"
  After that, \`gh vibe review <PR>\` will also cd you into the new worktree.

Requires: gh, git, and vibe in PATH.
`;

/**
 * Decide once, up front, whether the calling shell installed our wrapper.
 *
 * - Reads `GH_VIBE_SHELL` and then deletes it so child processes (vibe, git,
 *   gh) never see it and can't accidentally trigger shell-mode behavior of
 *   their own.
 * - If stdout is a TTY, the user almost certainly forgot the `eval` step or
 *   exported the env var manually. Refuse to emit raw shell commands at them
 *   and fall back to normal mode with a warning.
 * - Once shell mode is confirmed, redirect `console.log` to stderr so no
 *   stray log line can pollute the script the parent shell is about to eval.
 *
 * Exported for tests; not intended for external callers.
 */
export function initShellMode(): boolean {
  const envFlag = process.env.GH_VIBE_SHELL;
  delete process.env.GH_VIBE_SHELL;
  const requested = envFlag === "v1";
  if (!requested) return false;

  const isTty = process.stdout.isTTY === true;
  if (isTty) {
    process.stderr.write(
      "gh-vibe: shell mode requested but stdout is a TTY; " +
        "did you forget `eval \"$(gh vibe shell-setup)\"`? " +
        "Falling back to normal mode.\n",
    );
    return false;
  }

  // Redirect console.log → stderr so ad-hoc `console.log` calls anywhere in
  // the codebase can't corrupt the script we hand back to the parent shell.
  console.log = console.error;
  return true;
}

async function main(argv: string[]): Promise<number> {
  const shellMode = initShellMode();
  setShellMode(shellMode);

  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    console.log(HELP_TEXT);
    return 0;
  }
  if (argv[0] === "-v" || argv[0] === "--version") {
    console.log(`gh-vibe ${VERSION}`);
    return 0;
  }

  const [sub, ...rest] = argv;

  switch (sub) {
    case "review": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          "dry-run": { type: "boolean", short: "n", default: false },
          help: { type: "boolean", short: "h", default: false },
        },
        allowPositionals: true,
      });
      if (values.help) {
        console.log(
          "Usage: gh vibe review <PR# | URL> [--dry-run]\n\n" +
            "Fetches the PR's head branch (handling fork PRs) and creates a vibe worktree.",
        );
        return 0;
      }
      const prRef = positionals[0];
      if (!prRef) {
        console.error("Error: review requires a PR number or URL.");
        console.error("Usage: gh vibe review <PR# | URL>");
        return 2;
      }
      return await reviewCommand({ prRef, dryRun: values["dry-run"] });
    }
    case "shell-setup": {
      const { values } = parseArgs({
        args: rest,
        options: {
          help: { type: "boolean", short: "h", default: false },
        },
        allowPositionals: false,
      });
      if (values.help) {
        console.log(
          "Usage: gh vibe shell-setup\n\n" +
            "Prints a shell snippet that, when eval'd in bash or zsh, wraps\n" +
            "`gh` so `gh vibe review` cd's the parent shell into the worktree.\n\n" +
            "Install with:\n" +
            "  eval \"$(gh vibe shell-setup)\"",
        );
        return 0;
      }
      return shellSetupCommand();
    }
    default:
      console.error(`Unknown command: ${sub}`);
      console.error(HELP_TEXT);
      return 2;
  }
}

// Only run when invoked as the entry point so tests can import `initShellMode`
// (and any future internals) without triggering process.exit.
if (import.meta.main) {
  try {
    const code = await main(process.argv.slice(2));
    process.exit(code);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
