import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function exec(
  cmd: string,
  args: string[],
  opts: { stdio?: "inherit" | "pipe"; cwd?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const stdio = opts.stdio ?? "pipe";
    const child = spawn(cmd, args, { stdio, cwd: opts.cwd });

    let stdout = "";
    let stderr = "";

    if (stdio === "pipe") {
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", reject);
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
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${cmd} ${args.join(" ")}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}
