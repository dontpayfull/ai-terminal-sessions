// Follow Conversation Title, last resort: a conversation the agent never
// titled shows its first prompt. Claude Code writes its title a few seconds
// after the first prompt, so a running conversation waits before falling back
// (the tab would otherwise be renamed twice); a stopped one does not wait.

/** How long a running conversation may stay untitled before its first prompt
 *  stands in. */
export const FIRST_PROMPT_WAIT_MS = 45_000;
/** A transcript with no prompt yet is looked at again at most this often. */
export const FIRST_PROMPT_RETRY_MS = 30_000;

export interface FirstPromptCache {
  custom?: string;
  auto?: string;
  /** The first prompt, once found; it never changes. */
  first?: string;
  /** When it was found. */
  firstAt?: number;
  /** When the transcript was last read for it. */
  firstReadAt?: number;
}

/**
 * The first prompt to show as the title, or undefined when the conversation
 * has a real title, has no prompt yet, or (running) is still inside the wait.
 * `read` returns the transcript's first user message; it is called at most
 * once per retry window and never again after it answers.
 */
export function firstPromptTitle(
  c: FirstPromptCache,
  read: () => string | undefined,
  now: number,
  immediate: boolean,
): string | undefined {
  if (c.custom || c.auto) return undefined;
  if (!c.first && now - (c.firstReadAt ?? 0) >= FIRST_PROMPT_RETRY_MS) {
    c.firstReadAt = now;
    let first: string | undefined;
    try { first = read()?.trim() || undefined; } catch { first = undefined; }
    if (first) { c.first = first; c.firstAt = now; }
  }
  if (!c.first) return undefined;
  return immediate || now - (c.firstAt ?? now) >= FIRST_PROMPT_WAIT_MS ? c.first : undefined;
}
