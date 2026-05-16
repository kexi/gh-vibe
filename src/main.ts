import { parseArgs } from "node:util";
import { reviewCommand } from "./commands/review.ts";

const VERSION = "0.0.1";

const HELP_TEXT = `gh-vibe — gh CLI extension for vibe worktrees

Usage:
  gh vibe review <PR# | URL>   Create a worktree for reviewing a pull request

Options:
  -n, --dry-run    Print what would happen without fetching or creating a worktree
  -h, --help       Show this help
  -v, --version    Show version

Requires: gh, git, and vibe in PATH.
`;

async function main(argv: string[]): Promise<number> {
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
    default:
      console.error(`Unknown command: ${sub}`);
      console.error(HELP_TEXT);
      return 2;
  }
}

try {
  const code = await main(process.argv.slice(2));
  process.exit(code);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
