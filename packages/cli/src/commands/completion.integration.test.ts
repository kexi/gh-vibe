import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completionSnippet } from "./completion.ts";

/**
 * Integration tests for the snippets emitted by `gh vibe completion`. These
 * shell out to a real fish / zsh because the snippets are the public contract
 * with the user's interactive shell — string-match unit testing in
 * completion.test.ts can't catch a `local` keyword that's invalid in dash, or
 * a `[[ ]]` that breaks under POSIX `sh`.
 *
 * Each test that needs a real shell uses `test.skipIf(!hasShell(...))` so CI
 * environments without the shell installed simply skip instead of erroring.
 */

function hasShell(shell: string, probeArgs: string[] = ["-c", "exit 0"]): boolean {
  const result = spawnSync(shell, probeArgs, { stdio: "ignore" });
  return result.status === 0;
}

const HAS_ZSH = hasShell("zsh");
const HAS_FISH = hasShell("fish");

describe("completion snippet: syntax check", () => {
  // The completion snippets are emitted to be sourced verbatim by the user's
  // interactive shell, so we parse-check them the same way as shell-setup.
  // Catches issues like a stray `local` in zsh that bombs on the first
  // `compdef` attempt, or a fish typo that bricks the user's prompt the
  // moment they tab.
  test.skipIf(!HAS_FISH)(
    "fish -n parses completion snippet without syntax error",
    () => {
      const result = spawnSync("fish", ["-n", "/dev/stdin"], {
        input: completionSnippet("fish") ?? "",
        encoding: "utf8",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    },
  );

  test.skipIf(!HAS_ZSH)(
    "zsh -n parses completion snippet without syntax error",
    () => {
      const result = spawnSync("zsh", ["-n"], {
        input: completionSnippet("zsh") ?? "",
        encoding: "utf8",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    },
  );
});

describe("completion snippet: end-to-end behavior under real zsh", () => {
  // Reuse one tmpdir for: (a) a fake `gh` on PATH that emits canned
  // tab-separated PR rows, and (b) a per-run zcompdump file so compinit
  // doesn't poke the user's $HOME. Both are isolated to this describe block.
  let tmpDir: string;
  const zshSnippet = completionSnippet("zsh") ?? "";

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gh-vibe-completion-zsh-"));
    // Fake `gh` that prints two PR rows; the second title contains ':' so
    // the colon-sanitisation behaviour test can assert on a realistic input.
    const fakeGh = join(tmpDir, "gh");
    writeFileSync(
      fakeGh,
      "#!/usr/bin/env bash\n" +
        "printf '%s\\t%s\\n' '1' 'feat: add x'\n" +
        "printf '%s\\t%s\\n' '2' 'docs: y'\n",
      "utf8",
    );
    chmodSync(fakeGh, 0o755);
  });

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function runZsh(script: string): {
    stdout: string;
    stderr: string;
    status: number | null;
  } {
    // `zsh -f` skips the user's rc files so we get a deterministic env, then
    // we bootstrap compinit against a throwaway dump file inside tmpDir so we
    // never write to $HOME. The fake `gh` is first on PATH so `command gh`
    // inside the snippet resolves to it.
    const dump = join(tmpDir, ".zcompdump");
    const prelude =
      "autoload -Uz compinit\n" + `compinit -u -d "${dump}" 2>/dev/null\n`;
    const result = spawnSync("zsh", ["-f", "-c", prelude + script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tmpDir}:${process.env.PATH ?? ""}`,
      },
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status,
    };
  }

  // [required-F] The load-once sentinel must make a second eval silent. If a
  // future refactor ever lets the second pass re-`compdef`-overwrite the
  // wrapper or re-`functions -c _gh ...` over an existing copy, the user
  // would see warnings on every shell init; assert both are quiet.
  test.skipIf(!HAS_ZSH)(
    "second eval is a silent no-op (no stderr, wrapper still registered)",
    () => {
      const script = `
${zshSnippet}
${zshSnippet}
print -r -- "comps_gh=\${_comps[gh]:-undef}"
print -r -- "wrapper_present=$((${"$"}{+functions[_gh-vibe-wrapper]}))"
`;
      const { stdout, stderr, status } = runZsh(script);

      expect(stderr).toBe("");
      expect(stdout).toContain("comps_gh=_gh-vibe-wrapper");
      expect(stdout).toContain("wrapper_present=1");
      expect(status).toBe(0);
    },
  );

  // [required-E] Document the known limitation that gh's own zsh completion,
  // if sourced AFTER our snippet, will overwrite the `gh` compdef binding —
  // making `gh vibe …` completion go dark. This is documented in
  // completion.mdx; the test pins the behaviour so a future "rescue ourselves
  // on every TAB" patch can't regress without updating the docs.
  test.skipIf(!HAS_ZSH)(
    "gh's compdef issued AFTER snippet overrides the wrapper (documented behavior)",
    () => {
      const script = `
${zshSnippet}
print -r -- "before=\${_comps[gh]:-undef}"
# Simulate gh's official zsh completion landing AFTER our snippet — the
# canonical pattern there is to define _gh and then compdef it onto 'gh'.
_gh() { :; }
compdef _gh gh
print -r -- "after=\${_comps[gh]:-undef}"
`;
      const { stdout, stderr, status } = runZsh(script);

      expect(stderr).toBe("");
      expect(stdout).toContain("before=_gh-vibe-wrapper");
      // Regression check: late compdef wins. If this ever flips to
      // "after=_gh-vibe-wrapper" the docs (zsh load-order warning) should
      // probably be revised to match the new reality.
      expect(stdout).toContain("after=_gh");
      expect(status).toBe(0);
    },
  );

  // [required-H] _describe parses 'value:description', so a stray ':' inside
  // a PR title would split the entry and corrupt the rendering. We replace
  // ':' with ' ' before handing items to _describe; this asserts the actual
  // runtime behaviour, not just that the substitution syntax exists in the
  // snippet source.
  test.skipIf(!HAS_ZSH)(
    "PR titles containing ':' are sanitised before reaching _describe",
    () => {
      const script = `
${zshSnippet}
# Capture what __ghvibe_complete_prs hands to _describe by stubbing the latter.
# _describe is called as: _describe -t <tag> <name> <array_name>
_describe() {
  local arr_name=$4
  print -l -- "\${(@P)arr_name}"
}
# cd into tmpDir (which is not a git repo) so __ghvibe_cache_file returns ''
# and we hit the live (fake) gh path instead of any pre-existing cache file.
cd "${tmpDir}"
__ghvibe_complete_prs
`;
      const { stdout, stderr, status } = runZsh(script);

      expect(stderr).toBe("");
      // The two canned rows from the fake gh: '1\tfeat: add x' and
      // '2\tdocs: y'. After sanitisation the items handed to _describe must
      // be 'num:title-with-colons-replaced-by-spaces'.
      expect(stdout).toContain("1:feat  add x");
      expect(stdout).toContain("2:docs  y");
      // And crucially the original ':' inside the title is gone from each line.
      const itemLines = stdout
        .split("\n")
        .filter((l) => /^[0-9]+:/.test(l));
      for (const line of itemLines) {
        // Exactly one ':' (the value/description separator) — the title side
        // must not reintroduce another one.
        const colonCount = (line.match(/:/g) ?? []).length;
        expect(colonCount).toBe(1);
      }
      expect(status).toBe(0);
    },
  );
});
