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

export interface ExecOptions {
  stdio?: Stdio;
  cwd?: string;
  /**
   * Hard cap on accumulated stdout bytes. When exceeded the child is killed
   * and the promise rejects with `Error("stdout exceeded N bytes")`. Opt-in;
   * default is unlimited to preserve backward compatibility with existing
   * callers that legitimately collect large outputs.
   */
  maxStdoutBytes?: number;
}

export function exec(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const stdio = opts.stdio ?? "pipe";
    const child = spawn(cmd, args, { stdio, cwd: opts.cwd });

    // Accumulate as Buffer[] then concat once at close: `s += chunk.toString()`
    // would be O(N²) string copying for a 10 MB cap, and `chunk.byteLength` is
    // the right cap unit anyway (utf-8 bytes, not JS string code units).
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let overflowAborted = false;

    const stdoutPiped = Array.isArray(stdio) ? stdio[1] === "pipe" : stdio === "pipe";
    const stderrPiped = Array.isArray(stdio) ? stdio[2] === "pipe" : stdio === "pipe";
    const maxStdoutBytes = opts.maxStdoutBytes;
    const hasMaxStdout = typeof maxStdoutBytes === "number";
    if (stdoutPiped) {
      child.stdout?.on("data", (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buf.byteLength;
        const isOverflowing = hasMaxStdout && stdoutBytes > maxStdoutBytes;
        if (isOverflowing && !overflowAborted) {
          overflowAborted = true;
          child.kill();
          reject(new Error(`stdout exceeded ${maxStdoutBytes} bytes`));
          return;
        }
        if (!overflowAborted) stdoutChunks.push(buf);
      });
    }
    if (stderrPiped) {
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrChunks.push(buf);
      });
    }

    child.on("error", (err) => {
      if (overflowAborted) return;
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
      if (overflowAborted) return;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

export async function execOrThrow(
  cmd: string,
  args: string[],
  opts: { cwd?: string; maxStdoutBytes?: number } = {},
): Promise<string> {
  const result = await exec(cmd, args, {
    stdio: "pipe",
    cwd: opts.cwd,
    maxStdoutBytes: opts.maxStdoutBytes,
  });
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
