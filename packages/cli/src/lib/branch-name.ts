/**
 * Branch-name derivation for `gh vibe issue`.
 *
 * The exported `deriveBranchName` turns an issue (number + title + labels)
 * into a branch of the form `<type>/<num>-<slug>`. `slugify` and `inferType`
 * are exported primarily for unit tests; new callers should prefer
 * `deriveBranchName`.
 */

export type TypePrefix =
  | "feat"
  | "fix"
  | "docs"
  | "chore"
  | "refactor"
  | "test"
  | "perf";

export const ALLOWED_TYPES: readonly TypePrefix[] = [
  "feat",
  "fix",
  "docs",
  "chore",
  "refactor",
  "test",
  "perf",
];

/**
 * Lookup table from label name (already trimmed + lower-cased) to TypePrefix.
 *
 * SECURITY: built with `Object.create(null)` so attacker-controlled label
 * names like `__proto__` or `constructor` can't accidentally resolve to
 * methods inherited from `Object.prototype`. Do not refactor this into a
 * plain object literal.
 */
const LABEL_TO_TYPE: Record<string, TypePrefix> = Object.assign(
  Object.create(null),
  {
    feat: "feat",
    feature: "feat",
    enhancement: "feat",
    "new feature": "feat",
    fix: "fix",
    bug: "fix",
    bugfix: "fix",
    defect: "fix",
    docs: "docs",
    documentation: "docs",
    chore: "chore",
    dependencies: "chore",
    deps: "chore",
    build: "chore",
    ci: "chore",
    refactor: "refactor",
    refactoring: "refactor",
    cleanup: "refactor",
    test: "test",
    tests: "test",
    testing: "test",
    perf: "perf",
    performance: "perf",
  },
);

/**
 * Pick a `TypePrefix` from the first label whose normalised name maps to a
 * known type. Falls back to `"chore"` when no label matches (or the labels
 * array is empty).
 */
export function inferType(labelNames: string[]): TypePrefix {
  for (const raw of labelNames) {
    // Locale-independent normalisation: `toLowerCase` (NOT `toLocaleLowerCase`)
    // so labels behave identically regardless of the user's locale.
    const key = raw.trim().toLowerCase();
    const match = LABEL_TO_TYPE[key];
    if (match) return match;
  }
  return "chore";
}

/**
 * Slugify an issue title into the trailing segment of a branch name.
 *
 * Pipeline:
 *   1. NFKD normalise
 *   2. strip combining marks (\p{M})
 *   3. lowercase
 *   4. replace any run of non-[a-z0-9] with `-` (Unicode-strict allowlist)
 *   5. collapse repeated `-`
 *   6. trim leading/trailing `-`
 *   7. truncate to 50 chars then re-trim trailing `-`
 *   8. defensive `.lock` suffix guard — append `-x` if encountered (step 4
 *      should already prevent this, but we keep the guard so future edits to
 *      the allowlist don't silently re-enable `.lock`).
 *
 * Returns `""` when the input has no ASCII alphanumeric content (e.g.
 * Japanese-only or emoji-only titles); callers fall back to `issue-<n>`.
 */
export function slugify(title: string): string {
  let out = title.normalize("NFKD");
  out = out.replace(/\p{M}/gu, "");
  // SECURITY: must be `toLowerCase`, NOT `toLocaleLowerCase`. The Turkish
  // locale's dotted-i casing rules would otherwise turn `"I"` into `"ı"` and
  // make slugs non-deterministic across systems.
  out = out.toLowerCase();
  out = out.replace(/[^a-z0-9]+/g, "-");
  // Collapse input '-' chars that survived step 4 (which only collapses runs
  // of non-alphanumerics; a lone '-' in the input passes straight through).
  out = out.replace(/-+/g, "-");
  out = out.replace(/^-+|-+$/g, "");
  if (out.length > 50) {
    out = out.slice(0, 50).replace(/-+$/g, "");
  }
  const endsInLock = out.endsWith(".lock");
  if (endsInLock) {
    out = `${out}-x`;
  }
  return out;
}

export interface DeriveBranchNameInput {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
  typeOverride?: TypePrefix;
}

/**
 * Primary entry point for branch-name derivation. Combines `inferType`
 * (label → type, falls back to `"chore"`) with `slugify` (title → slug,
 * falls back to `issue-<n>`) to yield a branch of the form
 * `<type>/<num>-<slug>`.
 *
 * @param input.number       Issue number; embedded literally in the branch.
 * @param input.title        Issue title; slugified via `slugify`.
 * @param input.labels       GitHub label objects; only `.name` is consulted,
 *                           and only the first one that maps to a known type
 *                           wins (see `inferType`).
 * @param input.typeOverride If supplied, bypasses `inferType` entirely. The
 *                           caller is responsible for having validated it via
 *                           `validateType` first.
 */
export function deriveBranchName(input: DeriveBranchNameInput): string {
  const type =
    input.typeOverride ?? inferType(input.labels.map((l) => l.name));
  const rawSlug = slugify(input.title);
  const isEmptySlug = rawSlug === "";
  const slug = isEmptySlug ? `issue-${input.number}` : rawSlug;
  return `${type}/${input.number}-${slug}`;
}

/**
 * Validate a user-supplied `--type` value against `ALLOWED_TYPES`.
 *
 * SECURITY: strict equality only. Do NOT normalize, trim, or lowercase the
 * input — we don't want `"FEAT"`, `" feat "`, full-width `"ｆeat"`, or
 * NFKD-equivalent variants to slip through. The CLI surface is small enough
 * that requiring the canonical form keeps the audit story simple.
 */
export function validateType(raw: string): TypePrefix {
  const isAllowed = (ALLOWED_TYPES as readonly string[]).includes(raw);
  if (!isAllowed) {
    throw new Error(`--type must be one of: ${ALLOWED_TYPES.join(", ")}`);
  }
  return raw as TypePrefix;
}
