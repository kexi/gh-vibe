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
