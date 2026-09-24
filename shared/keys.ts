// What Enter does in a message box. Shared so the server's test runner can check it.

export interface EnterKey {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey?: boolean;
  /** IME composition in progress (CJK input): Enter confirms the composition, never sends. */
  isComposing: boolean;
  keyCode?: number;
}

/**
 * 'send' | 'newline' (insert one ourselves: Ctrl+Enter does not in a textarea) | 'ignore' (swallow) |
 * 'default' (let the browser do it). A hardware keyboard (a desktop's, an iPad's): Enter sends,
 * Shift/Ctrl/Cmd+Enter make a new line, and an empty message makes Enter do nothing. `touch` is an
 * on-screen keyboard (a phone's or a tablet's own): Enter is a new line, the Send button sends.
 */
export function enterAction(e: EnterKey, opts: { touch: boolean; canSend: boolean }): 'send' | 'newline' | 'ignore' | 'default' {
  if (e.key !== 'Enter') return 'default';
  if (e.isComposing || e.keyCode === 229) return 'default';
  if (opts.touch) return 'default';
  if (e.shiftKey) return 'default';
  if (e.ctrlKey || e.metaKey) return 'newline';
  if (e.altKey) return 'default';
  return opts.canSend ? 'send' : 'ignore';
}
