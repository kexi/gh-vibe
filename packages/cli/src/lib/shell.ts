/**
 * Helpers for emitting shell commands that are eval'd by the gh-vibe shell
 * wrapper (see `gh vibe shell-setup`).
 *
 * Anything we hand back to the shell goes through `shellQuote` first, and we
 * gate emission on `assertSafeShellPath` so that paths containing control or
 * format characters (e.g. embedded newlines, NULs, or bidi overrides) can never
 * construct extra commands in the user's shell.
 */

/**
 * Reject paths that contain Unicode control (Cc) or format (Cf) characters.
 *
 * Lets through normal Unicode like Japanese — only stops bytes that could
 * smuggle additional shell commands past `shellQuote` once the line is eval'd.
 *
 * SECURITY: `\p{Cf}` is intentional and must not be loosened. It covers
 * U+202E RIGHT-TO-LEFT OVERRIDE and other bidi controls, plus invisible
 * format characters like U+200B ZERO WIDTH SPACE that could trick a human
 * reviewer about what they're about to `eval`.
 */
export function assertSafeShellPath(s: string): void {
  const hasUnsafeChar = /[\p{Cc}\p{Cf}]/u.test(s);
  if (hasUnsafeChar) {
    throw new Error(
      "Refusing to emit shell command: path contains control or format characters.",
    );
  }
}

/**
 * Quote a string for POSIX shells using single-quote escaping. Safe against
 * `$`, `;`, backticks, etc. because nothing is expanded inside single quotes.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The single sanctioned helper for writing to stdout in shell mode. Any other
 * code path that wants to surface text to the user MUST use `log` (stderr).
 *
 * `shellLine` is the (already-quoted) shell command to fence — typically a
 * `cd` invocation today, but the function makes no assumption beyond that the
 * caller has produced a single-line, sentinel-safe command.
 *
 * The output is fenced with magic sentinels so the shell wrapper can
 * distinguish "this is a script to eval" from arbitrary stdout it might
 * otherwise dump back to the terminal.
 */
export function emitShellCommand(
  writeStdout: (s: string) => void,
  shellLine: string,
): void {
  writeStdout(`# __ghvibe_v1_begin__\n${shellLine}\n# __ghvibe_v1_end__\n`);
}
