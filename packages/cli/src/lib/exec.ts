import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class ExecError extends Error {
  readonly cmd: string;
  readonly args: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;

  constructor(params: {
    cmd: string;
    args: string[];
    stdout: string;
    stderr: string;
    exitCode: number;
  }) {
    super(`${params.cmd} exited with code ${params.exitCode}`);
    this.name = "ExecError";
    this.cmd = params.cmd;
    this.args = params.args;
    this.stdout = params.stdout;
    this.stderr = params.stderr;
    this.exitCode = params.exitCode;
  }
}

export type StdioOption = "inherit" | "pipe" | "ignore";
export type Stdio = StdioOption | [StdioOption, StdioOption, StdioOption];

export function exec(
  cmd: string,
  args: string[],
  opts: { stdio?: Stdio; cwd?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const stdio = opts.stdio ?? "pipe";
    const child = spawn(cmd, args, { stdio, cwd: opts.cwd });

    let stdout = "";
    let stderr = "";

    // Only collect output from streams that were actually piped.
    const stdoutPiped = Array.isArray(stdio) ? stdio[1] === "pipe" : stdio === "pipe";
    const stderrPiped = Array.isArray(stdio) ? stdio[2] === "pipe" : stdio === "pipe";
    if (stdoutPiped) {
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
    }
    if (stderrPiped) {
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", (err) => {
      // Translate ENOENT (binary not on PATH) into a user-actionable message
      // here so every caller — issueCommand, reviewCommand, vibe exec, raw git
      // / gh calls — gets the same friendly form without each having to wrap.
      const errCode = (err as NodeJS.ErrnoException).code;
      const isMissing = errCode === "ENOENT";
      if (isMissing) {
        reject(new Error(`${cmd}: command not found in PATH.`));
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

export async function execOrThrow(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<string> {
  const result = await exec(cmd, args, { stdio: "pipe", cwd: opts.cwd });
  const isFailed = result.exitCode !== 0;
  if (isFailed) {
    throw new ExecError({
      cmd,
      args,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }
  return result.stdout;
}
