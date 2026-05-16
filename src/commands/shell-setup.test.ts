import { describe, expect, test } from "bun:test";
import {
  SHELL_SETUP_SNIPPET,
  shellSetupCommand,
} from "./shell-setup.ts";

describe("shellSetupCommand", () => {
  test("writes the canonical snippet exactly once and returns 0", () => {
    const chunks: string[] = [];
    const code = shellSetupCommand({
      writeStdout: (s) => chunks.push(s),
    });
    expect(code).toBe(0);
    expect(chunks).toEqual([SHELL_SETUP_SNIPPET]);
  });
});

describe("SHELL_SETUP_SNIPPET content", () => {
  test("invokes the real binary via `command gh`, never recursing", () => {
    expect(SHELL_SETUP_SNIPPET).toContain("command gh");
  });

  test("opts the binary into shell mode via GH_VIBE_SHELL=v1", () => {
    expect(SHELL_SETUP_SNIPPET).toContain("GH_VIBE_SHELL=v1");
  });

  test("only eval's output fenced by the v1 begin/end sentinels", () => {
    expect(SHELL_SETUP_SNIPPET).toContain(": __ghvibe_v1_begin__");
    expect(SHELL_SETUP_SNIPPET).toContain(": __ghvibe_v1_end__");
  });

  test("guards against double-loading", () => {
    expect(SHELL_SETUP_SNIPPET).toContain("_GH_VIBE_SHELL_SETUP_LOADED");
  });

  test("detects an existing gh function or alias before installing", () => {
    expect(SHELL_SETUP_SNIPPET).toContain("gh is a function");
    expect(SHELL_SETUP_SNIPPET).toContain("alias gh");
  });

  test("only triggers wrapper behavior for the `vibe` subcommand", () => {
    // The wrapper must fall through to `command gh` for non-vibe args so it
    // doesn't break `gh pr`, `gh repo`, etc.
    expect(SHELL_SETUP_SNIPPET).toContain('[ "$1" = "vibe" ]');
  });
});
