export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Strip ANSI and replace Unicode Cc/Cf characters with `?`. Use for any path
 * or branch name interpolated into log lines so a malicious worktree path
 * can't inject escape sequences or bidi overrides into the user's terminal.
 *
 * Display-only. The throw-variant for stdout emission is `assertSafeShellPath`
 * in `shell.ts`.
 */
export function sanitizeForLog(s: string): string {
  return stripAnsi(s).replace(/[\p{Cc}\p{Cf}]/gu, "?");
}

export function maskSecrets(s: string): string {
  let out = s;
  // Classic gh tokens: ghp_*, gho_*, ghu_*, ghs_*, ghr_*
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "gh*_***");
  // Fine-grained PATs: github_pat_*
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_***");
  // URL-embedded credentials: https://user:token@host
  out = out.replace(/(https?:\/\/)[^:@/\s]+:[^@/\s]+@/g, "$1***@");
  return out;
}
