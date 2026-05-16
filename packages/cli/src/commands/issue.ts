import {
  type TypePrefix,
  deriveBranchName,
} from "../lib/branch-name.ts";
import { type Stdio, exec } from "../lib/exec.ts";
import { viewIssue } from "../lib/gh.ts";
import {
  assertValidRefName,
  fetchBranch,
  getDefaultBranch,
  localBranchExists,
  worktreePathForBranch,
} from "../lib/git.ts";
import { getShellMode } from "../lib/runtime.ts";
import {
  assertSafeShellPath,
  emitShellCommand,
  shellQuote,
} from "../lib/shell.ts";

export interface IssueOptions {
  issueRef: string;
  dryRun: boolean;
  base?: string;
  type?: TypePrefix;
}

/**
 * Seams for `issueCommand` so tests can inject mocks. Defaults wire up the
 * real gh / git / vibe callers plus the real stdout / TTY / env probes.
 */
export interface IssueDeps {
  viewIssue: typeof viewIssue;
  getDefaultBranch: typeof getDefaultBranch;
  assertValidRefName: typeof assertValidRefName;
  fetchBranch: typeof fetchBranch;
  localBranchExists: typeof localBranchExists;
  worktreePathForBranch: typeof worktreePathForBranch;
  exec: typeof exec;
  log: (msg: string) => void;
  writeStdout: (s: string) => void;
  isShellMode: () => boolean;
  isStdoutTty: () => boolean;
}

const defaultDeps: IssueDeps = {
  viewIssue,
  getDefaultBranch,
  assertValidRefName,
  fetchBranch,
  localBranchExists,
  worktreePathForBranch,
  exec,
  log: (msg) => console.error(msg),
  writeStdout: (s) => {
    process.stdout.write(s);
  },
  isShellMode: () => getShellMode(),
  isStdoutTty: () => process.stdout.isTTY === true,
};

export async function issueCommand(
  opts: IssueOptions,
  deps: IssueDeps = defaultDeps,
): Promise<number> {
  // Inline `opts.base !== undefined` so TS narrows `opts.base` to `string` in
  // the truthy branch (a separate boolean alias loses the narrowing).
  const base =
    opts.base !== undefined ? opts.base : await deps.getDefaultBranch();

  // Defense in depth: even though `main.ts` already rejects `--base -foo`, we
  // re-check here so library callers can't bypass it.
  const baseLooksLikeFlag = base.startsWith("-");
  if (baseLooksLikeFlag) {
    throw new Error(`Refusing base ref starting with '-': ${base}`);
  }
  deps.assertValidRefName(base);

  const issue = await deps.viewIssue(opts.issueRef);
  const branch = deriveBranchName({
    number: issue.number,
    title: issue.title,
    labels: issue.labels,
    typeOverride: opts.type,
  });

  deps.log(`Issue #${issue.number}: ${issue.title}`);
  deps.log(`  Branch: ${branch} (base: ${base})`);

  // Pre-flight: keep this *before* the dry-run short-circuit so users can
  // catch the collision in dry-run mode too.
  const alreadyExists = await deps.localBranchExists(branch);
  if (alreadyExists) {
    throw new Error(
      `Local branch '${branch}' already exists. ` +
        "Pick a different --type or delete it first.",
    );
  }

  if (opts.dryRun) {
    return 0;
  }

  await deps.fetchBranch("origin", base);

  // In shell mode the parent shell will be eval'ing our stdout, so vibe's own
  // stdout must not leak into it. Discard vibe stdout, keep stderr inherited
  // so progress / errors still reach the user.
  const isShellMode = deps.isShellMode();
  const vibeStdio: Stdio = isShellMode
    ? ["inherit", "ignore", "inherit"]
    : "inherit";
  const result = await deps.exec(
    "vibe",
    ["start", branch, "--base", base],
    { stdio: vibeStdio },
  );
  const isVibeFailed = result.exitCode !== 0;
  if (isVibeFailed) {
    return result.exitCode;
  }

  if (!isShellMode) {
    return 0;
  }

  // Shell mode: hand the parent shell a `cd` to the worktree. Any failure
  // path returns non-zero so the wrapper's success guard skips the eval.
  const worktreePath = await deps.worktreePathForBranch(branch);
  if (!worktreePath) {
    deps.log(`Could not find a worktree for branch '${branch}' (cd skipped).`);
    return 1;
  }
  assertSafeShellPath(worktreePath);
  emitShellCommand(deps.writeStdout, `cd ${shellQuote(worktreePath)}`);
  return 0;
}
