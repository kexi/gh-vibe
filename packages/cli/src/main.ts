import { parseArgs } from "node:util";
import { cleanCommand } from "./commands/clean.ts";
import { issueCommand } from "./commands/issue.ts";
import { reviewCommand } from "./commands/review.ts";
import {
  SUPPORTED_SHELLS,
  type ShellKind,
  detectShell,
  shellSetupCommand,
} from "./commands/shell-setup.ts";
import { type TypePrefix, validateType } from "./lib/branch-name.ts";
import { setShellMode } from "./lib/runtime.ts";
import { parseStateList } from "./lib/state.ts";

const VERSION = "0.0.2";

const HELP_TEXT = `gh-vibe — gh CLI extension for vibe worktrees

Usage:
  gh vibe review <PR# | URL>   Create a worktree for reviewing a pull request
  gh vibe issue <# | URL>      Create a worktree for working on an issue
  gh vibe clean                Bulk-remove vibe worktrees whose PR is merged/closed
  gh vibe shell-setup          Print shell wrapper that auto-cd's into the worktree

Options:
  -n, --dry-run    Print what would happen without fetching or creating a worktree
  -h, --help       Show this help
  -v, --version    Show version

Shell integration:
  bash / zsh:
      eval "$(gh vibe shell-setup)"           # ~/.bashrc or ~/.zshrc
  fish:
      gh vibe shell-setup --shell=fish | source   # ~/.config/fish/config.fish
  PowerShell:
      gh vibe shell-setup --shell=pwsh | Out-String | Invoke-Expression   # $PROFILE
  After that, \`gh vibe review <PR>\` and \`gh vibe issue <#>\` will also cd
  you into the new worktree.

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

/**
 * Test seam. Tests inject mocked subcommand implementations so they can
 * verify argv parsing / dispatch without spawning real `gh` / `git` / `vibe`.
 *
 * @internal
 */
export interface MainDeps {
  issueCommand: typeof issueCommand;
  reviewCommand: typeof reviewCommand;
  cleanCommand: typeof cleanCommand;
}

/**
 * Concrete shape of `parseArgs(...)` output for the `issue` subcommand.
 * Extracted so we don't have to repeat the inline cast twice (once at the
 * catch boundary and once when destructuring).
 */
type ParsedIssueArgs = {
  values: {
    "dry-run": boolean;
    base?: string;
    type?: string;
    help: boolean;
  };
  positionals: string[];
};

/** Exported only for tests; production callers should use the entry-point block. */
export async function main(
  argv: string[],
  deps: MainDeps = { issueCommand, reviewCommand, cleanCommand },
): Promise<number> {
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
      let parsed;
      try {
        parsed = parseArgs({
          args: rest,
          options: {
            "dry-run": { type: "boolean", short: "n", default: false },
            help: { type: "boolean", short: "h", default: false },
          },
          allowPositionals: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        console.error("Usage: gh vibe review <PR# | URL>");
        return 2;
      }
      const { values, positionals } = parsed;
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
      // Reject positionals that look like a flag — mirrors the `issue` guard
      // so `-1` can't be misinterpreted by anything downstream as an option.
      const prRefLooksLikeFlag = prRef.startsWith("-");
      if (prRefLooksLikeFlag) {
        console.error(
          `Error: PR ref must not start with '-' (got: ${prRef}).`,
        );
        return 2;
      }
      return await deps.reviewCommand({ prRef, dryRun: values["dry-run"] });
    }
    case "issue": {
      // `parseArgs` throws on a few user-error shapes we already intend to
      // exit 2 on (dash-prefixed positional, missing option arg). Translate
      // those into a friendly stderr + exit 2 instead of bubbling.
      let parsed: ParsedIssueArgs | undefined;
      try {
        parsed = parseArgs({
          args: rest,
          options: {
            "dry-run": { type: "boolean", short: "n", default: false },
            base: { type: "string" },
            type: { type: "string" },
            help: { type: "boolean", short: "h", default: false },
          },
          allowPositionals: true,
        }) as ParsedIssueArgs;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        console.error("Usage: gh vibe issue <# | URL> [options]");
        return 2;
      }
      const { values, positionals } = parsed;
      if (values.help) {
        console.log(
          "Usage: gh vibe issue <# | URL> [options]\n\n" +
            "Create a vibe worktree for working on an issue. The branch name is\n" +
            "derived from the issue's labels and title: <type>/<num>-<slug>.\n\n" +
            "Options:\n" +
            "  -n, --dry-run    Print the derived branch + base and exit without\n" +
            "                   fetching or invoking vibe. (Still queries the GitHub\n" +
            "                   API to compute the slug.)\n" +
            "  --base <ref>     Base branch (default: repository's default branch).\n" +
            "  --type <t>       Override label-inferred type (feat | fix | docs |\n" +
            "                   chore | refactor | test | perf).\n" +
            "  -h, --help       Show this help.",
        );
        return 0;
      }
      const issueRef = positionals[0];
      if (!issueRef) {
        console.error("Error: issue requires an issue number or URL.");
        console.error("Usage: gh vibe issue <# | URL>");
        return 2;
      }
      // Reject positionals that look like a flag — even if `gh issue view`
      // would accept them, treating `-1` as a positional invites argv
      // injection surprises further down the pipeline.
      const issueRefLooksLikeFlag = issueRef.startsWith("-");
      if (issueRefLooksLikeFlag) {
        console.error(
          `Error: issue number must not start with '-' (got: ${issueRef}).`,
        );
        return 2;
      }
      const rawBase = values.base;
      const baseLooksLikeFlag =
        rawBase !== undefined && rawBase.startsWith("-");
      if (baseLooksLikeFlag) {
        console.error(
          `Error: --base must not start with '-' (got: ${rawBase}).`,
        );
        return 2;
      }
      let type: TypePrefix | undefined;
      if (values.type !== undefined) {
        try {
          type = validateType(values.type);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Error: ${message}`);
          return 2;
        }
      }
      return await deps.issueCommand({
        issueRef,
        dryRun: values["dry-run"],
        base: rawBase,
        type,
      });
    }
    case "clean": {
      let parsed;
      try {
        parsed = parseArgs({
          args: rest,
          options: {
            "dry-run": { type: "boolean", short: "n", default: false },
            state: { type: "string" },
            "include-no-pr": { type: "boolean", default: false },
            yes: { type: "boolean", default: false },
            "allow-no-default-branch": { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
          },
          allowPositionals: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        console.error("Usage: gh vibe clean [options]");
        return 2;
      }
      const { values } = parsed;
      if (values.help) {
        console.log(
          "Usage: gh vibe clean [options]\n\n" +
            "Bulk-removes vibe worktrees whose backing PR is merged or closed.\n\n" +
            "Options:\n" +
            "  -n, --dry-run                 List candidates without deleting.\n" +
            "      --state <list>            Comma-separated subset of {merged,closed}.\n" +
            "                                Default: merged,closed.\n" +
            "      --include-no-pr           Also clean worktrees whose branch has no PR.\n" +
            "      --yes                     Skip the typed-count confirmation prompt.\n" +
            "      --allow-no-default-branch Proceed even when origin/HEAD is unset.\n" +
            "  -h, --help                    Show this help.",
        );
        return 0;
      }
      let state: ReadonlySet<"MERGED" | "CLOSED">;
      if (values.state !== undefined) {
        try {
          state = parseStateList(values.state);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Error: ${message}`);
          return 2;
        }
      } else {
        state = new Set<"MERGED" | "CLOSED">(["MERGED", "CLOSED"]);
      }
      return await deps.cleanCommand({
        dryRun: values["dry-run"],
        state,
        includeNoPr: values["include-no-pr"],
        yes: values.yes,
        allowNoDefaultBranch: values["allow-no-default-branch"],
      });
    }
    case "shell-setup": {
      const { values } = parseArgs({
        args: rest,
        options: {
          shell: { type: "string" },
          help: { type: "boolean", short: "h", default: false },
        },
        allowPositionals: false,
      });
      if (values.help) {
        console.log(
          "Usage: gh vibe shell-setup [--shell=<bash|zsh|fish|pwsh>]\n\n" +
            "Prints a shell wrapper that makes `gh vibe review` and\n" +
            "`gh vibe issue` cd the parent shell into the worktree on success.\n" +
            "The output is shell-specific; without --shell, the calling shell\n" +
            "is auto-detected from $SHELL (or $PSModulePath for PowerShell).\n\n" +
            "Install with:\n" +
            "  bash/zsh:  eval \"$(gh vibe shell-setup)\"\n" +
            "  fish:      gh vibe shell-setup --shell=fish | source\n" +
            "  pwsh:      gh vibe shell-setup --shell=pwsh | Out-String | Invoke-Expression",
        );
        return 0;
      }
      const requestedShell = values.shell;
      const isValidShell = (s: string): s is ShellKind =>
        (SUPPORTED_SHELLS as readonly string[]).includes(s);
      if (requestedShell !== undefined && !isValidShell(requestedShell)) {
        console.error(
          `Unknown --shell value: ${requestedShell}. ` +
            `Supported: ${SUPPORTED_SHELLS.join(", ")}.`,
        );
        return 2;
      }
      const shell = requestedShell ?? detectShell();
      return shellSetupCommand(shell);
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
