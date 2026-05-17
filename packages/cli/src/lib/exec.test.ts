import { describe, expect, test } from "bun:test";
import { exec } from "./exec.ts";

describe("exec", () => {
  // R2: a missing binary surfaces as a friendly "command not found in PATH"
  // error rather than a raw ENOENT spawn failure. Translating this once at the
  // spawn boundary keeps every caller (issue, review, vibe wrapper, gh, git)
  // consistent without each needing its own try/catch.
  test("ENOENT translates to friendly 'command not found in PATH'", async () => {
    // Path-shaped name with no slashes that almost certainly does not exist on
    // PATH; we are not testing real binaries here, only the error translation.
    const missing = "definitely-not-a-real-binary-xyz-9f3a";
    await expect(exec(missing, [])).rejects.toThrow(
      `${missing}: command not found in PATH.`,
    );
  });
});

describe("exec: maxStdoutBytes", () => {
  test("stdout output exceeding the bound rejects with overflow error", async () => {
    // 4 KiB of output; bound is 64 bytes so the very first chunk overflows.
    await expect(
      exec("sh", ["-c", "head -c 4096 /dev/zero"], { maxStdoutBytes: 64 }),
    ).rejects.toThrow(/stdout exceeded 64 bytes/);
  });

  test("stdout output under the bound resolves normally", async () => {
    const result = await exec("sh", ["-c", "printf hi"], {
      maxStdoutBytes: 1024,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi");
  });

  test("no bound set: large output is accepted (default unlimited)", async () => {
    const result = await exec("sh", ["-c", "head -c 4096 /dev/zero | wc -c"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("4096");
  });
});
