/**
 * Process-wide runtime flags, set once by `main.ts` at startup *after* it
 * reads and clears `GH_VIBE_SHELL` from the environment (so child processes
 * don't inherit it).
 *
 * Code that wants to know whether we are in shell mode reads it through
 * `getShellMode()`; that indirection lets tests inject their own value via
 * dependency-injected seams instead of mutating module state.
 */
let shellMode = false;

/** Called exactly once by `main.ts` at startup. Not for use elsewhere. */
export function setShellMode(value: boolean): void {
  shellMode = value;
}

export function getShellMode(): boolean {
  return shellMode;
}
