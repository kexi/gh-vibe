/**
 * Helpers for emitting shell commands that are eval'd by the gh-vibe shell
 * wrapper (see `gh vibe shell-setup`).
 *
 * Anything we hand back to the shell goes through `shellQuote` first, and we
 * gate emission on `assertSafeShellPath` so that paths containing control
 * characters (e.g. embedded newlines or NULs) can never construct extra
 * commands in the user's shell.
 */

/**
 * Reject paths that contain Unicode control characters (category Cc).
 *
 * Lets through normal Unicode like Japanese — only stops bytes that could
 * smuggle additional shell commands past `shellQuote` once the line is eval'd.
 */
export function assertSafeShellPath(s: string): void {
  const hasControlChar = /\p{Cc}/u.test(s);
  if (hasControlChar) {
    throw new Error(
      "Refusing to emit shell command: path contains control characters.",
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
