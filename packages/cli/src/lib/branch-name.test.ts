import { describe, expect, test } from "bun:test";
import {
  ALLOWED_TYPES,
  deriveBranchName,
  inferType,
  slugify,
  type TypePrefix,
  validateType,
} from "./branch-name.ts";

describe("inferType", () => {
  const happyPaths: Array<[TypePrefix, string[]]> = [
    ["feat", ["feat"]],
    ["feat", ["feature"]],
    ["feat", ["enhancement"]],
    ["feat", ["new feature"]],
    ["fix", ["fix"]],
    ["fix", ["bug"]],
    ["fix", ["bugfix"]],
    ["fix", ["defect"]],
    ["docs", ["docs"]],
    ["docs", ["documentation"]],
    ["chore", ["chore"]],
    ["chore", ["dependencies"]],
    ["chore", ["deps"]],
    ["chore", ["build"]],
    ["chore", ["ci"]],
    ["refactor", ["refactor"]],
    ["refactor", ["refactoring"]],
    ["refactor", ["cleanup"]],
    ["test", ["test"]],
    ["test", ["tests"]],
    ["test", ["testing"]],
    ["perf", ["perf"]],
    ["perf", ["performance"]],
  ];

  for (const [expected, labels] of happyPaths) {
    test(`maps ${JSON.stringify(labels)} → ${expected}`, () => {
      expect(inferType(labels)).toBe(expected);
    });
  }

  test("input labels are case-insensitive", () => {
    expect(inferType(["Bug"])).toBe("fix");
    expect(inferType(["FEATURE"])).toBe("feat");
  });

  test("input labels are whitespace-insensitive", () => {
    expect(inferType([" enhancement "])).toBe("feat");
    expect(inferType(["\tfix\n"])).toBe("fix");
  });

  test("first matching label wins", () => {
    // 'bug' → fix, 'enhancement' → feat; whichever comes first in the array
    // determines the result.
    expect(inferType(["bug", "enhancement"])).toBe("fix");
    expect(inferType(["enhancement", "bug"])).toBe("feat");
  });

  test("unknown labels fall back to chore", () => {
    expect(inferType(["needs-triage"])).toBe("chore");
    expect(inferType(["wontfix", "duplicate"])).toBe("chore");
  });

  test("empty label array falls back to chore", () => {
    expect(inferType([])).toBe("chore");
  });

  // SECURITY: malicious labels must not resolve to inherited Object methods.
  test("__proto__ label does not resolve to Object.prototype", () => {
    expect(inferType(["__proto__"])).toBe("chore");
    expect(inferType(["constructor"])).toBe("chore");
    expect(inferType(["hasOwnProperty"])).toBe("chore");
    expect(inferType(["toString"])).toBe("chore");
  });
});

describe("slugify", () => {
  test("plain ASCII title", () => {
    expect(slugify("Fix the login bug")).toBe("fix-the-login-bug");
  });

  test("collapses consecutive separators", () => {
    expect(slugify("foo   bar---baz")).toBe("foo-bar-baz");
  });

  test("trims leading/trailing separators", () => {
    expect(slugify("---hello---")).toBe("hello");
    expect(slugify("   leading and trailing   ")).toBe(
      "leading-and-trailing",
    );
  });

  test("strips NFKD accents", () => {
    expect(slugify("Café")).toBe("cafe");
    expect(slugify("naïve résumé")).toBe("naive-resume");
  });

  test("Japanese-only title becomes empty string", () => {
    expect(slugify("日本語のタイトル")).toBe("");
  });

  test("emoji-only title becomes empty string", () => {
    expect(slugify("🎉🚀✨")).toBe("");
  });

  test("mixed Unicode + ASCII keeps only the ASCII alnum runs", () => {
    expect(slugify("Fix 日本語 bug")).toBe("fix-bug");
  });

  test("max-length truncation at 50 chars and trailing - trim", () => {
    // 60 chars: "a" * 60. After truncation: 50 chars, no trailing `-`.
    const long = "a".repeat(60);
    const result = slugify(long);
    expect(result.length).toBe(50);
    expect(result).toBe("a".repeat(50));
  });

  test("truncation trims trailing - when cut lands on a separator", () => {
    // Construct an input whose 50th char is `-`. 49 a's, space, 11 b's →
    // "aaaa...a-bbbbbbbbbbb"; truncate to 50 → "aaaa...a-" → trim → 49 chars.
    const input = `${"a".repeat(49)} ${"b".repeat(11)}`;
    const result = slugify(input);
    expect(result.endsWith("-")).toBe(false);
    expect(result).toBe("a".repeat(49));
  });

  // Each forbidden git-ref char is replaced by `-` via the allowlist.
  test.each([
    ["double dot", "a..b", "a-b"],
    ["tilde", "a~b", "a-b"],
    ["caret", "a^b", "a-b"],
    ["colon", "a:b", "a-b"],
    ["question", "a?b", "a-b"],
    ["asterisk", "a*b", "a-b"],
    ["open bracket", "a[b", "a-b"],
    ["backslash", "a\\b", "a-b"],
    ["space", "a b", "a-b"],
    ["tab", "a\tb", "a-b"],
    ["newline", "a\nb", "a-b"],
  ])("strips forbidden ref char (%s)", (_label, input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  // U+1F389 PARTY POPPER is an astral codepoint encoded as a surrogate pair
  // in JavaScript. Ensure no half-surrogate leaks into the output.
  test("astral / surrogate-pair characters are stripped cleanly", () => {
    const result = slugify("hello \u{1F389} world");
    expect(result).toBe("hello-world");
    // No lone surrogates and only allowlist chars survive.
    expect(/^[a-z0-9-]*$/.test(result)).toBe(true);
  });

  test("output never starts or ends with -", () => {
    for (const input of [
      "---",
      "   foo   ",
      "%%foo%%",
      "Fix 日本語 bug",
      "hello \u{1F389} world",
    ]) {
      const out = slugify(input);
      const startsOrEndsWithDash = out.startsWith("-") || out.endsWith("-");
      expect(startsOrEndsWithDash).toBe(false);
    }
  });

  // The `.lock` guard is defensive — step 4 already strips `.`, so a normal
  // input can't reach `.lock`. We document the guard's intent here: titles
  // containing "lock" still produce a clean slug (no `.lock` suffix kicks in
  // unless the codepath is later weakened).
  test("title containing 'lock' produces a plain slug, no -x suffix", () => {
    expect(slugify("Add lock")).toBe("add-lock");
    // Even with a dot adjacent — the dot becomes `-`, never `.lock`.
    expect(slugify("hot.lock")).toBe("hot-lock");
  });

  // Property-style: a handful of Unicode-heavy inputs all conform to the
  // output charset and edge invariants. (No fast-check dependency.)
  test("Unicode-heavy fixtures all produce charset-conforming output", () => {
    const fixtures = [
      "日本語のタイトル",
      "Café résumé",
      "العربية",
      "Привет мир",
      "Fix 日本語 bug",
      "hello \u{1F389} world",
      "한국어 제목",
      "Ελληνικά",
      "中文标题",
      "Tiếng Việt",
      "𝓗𝓮𝓵𝓵𝓸 world",
      "ｆｅａｔ wide",
      "    ",
      "\t\n\r",
      "🎉🚀✨",
      "user@example.com",
      "foo/bar:baz",
      "v1.2.3 release",
      "C# language fix",
      "API v2: rate-limit bug",
    ];
    for (const input of fixtures) {
      const out = slugify(input);
      const matchesCharset = /^[a-z0-9-]*$/.test(out);
      const startsOrEndsWithDash = out.startsWith("-") || out.endsWith("-");
      expect(matchesCharset).toBe(true);
      expect(startsOrEndsWithDash).toBe(false);
      expect(out.length).toBeLessThanOrEqual(50);
    }
  });
});

describe("deriveBranchName", () => {
  test("happy-path full assembly", () => {
    const branch = deriveBranchName({
      number: 42,
      title: "Fix the login bug",
      labels: [{ name: "bug" }],
    });
    expect(branch).toBe("fix/42-fix-the-login-bug");
  });

  test("empty-slug fallback uses issue-<n>", () => {
    const branch = deriveBranchName({
      number: 7,
      title: "日本語のみ",
      labels: [],
    });
    expect(branch).toBe("chore/7-issue-7");
  });

  test("typeOverride wins over labels", () => {
    const branch = deriveBranchName({
      number: 99,
      title: "Add cache layer",
      labels: [{ name: "bug" }],
      typeOverride: "feat",
    });
    expect(branch).toBe("feat/99-add-cache-layer");
  });
});

describe("validateType", () => {
  for (const t of ALLOWED_TYPES) {
    test(`accepts ${t}`, () => {
      expect(validateType(t)).toBe(t);
    });
  }

  // Strict equality — no normalization permitted.
  test.each([
    ["uppercase", "FEAT"],
    ["padded", " feat "],
    ["alias (not canonical)", "feature"],
    ["full-width", "ｆeat"],
    ["empty", ""],
    ["unknown", "bogus"],
  ])("rejects %s", (_label, raw) => {
    expect(() => validateType(raw)).toThrow("--type must be one of");
  });
});
