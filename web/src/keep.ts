// What a reload for a new version must not lose (w1489). A box that keeps its text, an open "deny and say why" form, the
// place a chat was scrolled to: each is written to this tab's sessionStorage (which a reload keeps and a new tab starts
// without) and read back when the page is drawn again. Anything a page cannot keep this way makes it wait instead
// (web/src/freshness.ts, shared/freshness.ts busyLevel).
import { useEffect, useState } from 'react';

const PREFIX = 'ffsb.kept.';
/** A kept value this old belongs to something long gone (a card nobody opened again). */
const MAX_AGE_MS = 6 * 3600_000;

function read<T>(key: string): T | undefined {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (!raw) return undefined;
    const { v, t } = JSON.parse(raw) as { v: T; t: number };
    return Date.now() - t < MAX_AGE_MS ? v : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === undefined) sessionStorage.removeItem(PREFIX + key);
    else sessionStorage.setItem(PREFIX + key, JSON.stringify({ v: value, t: Date.now() }));
  } catch {
    /* storage full or off: the reload waits for such a box instead (it is not marked data-kept by then) */
  }
}

type Widen<T> = T extends string ? string : T extends boolean ? boolean : number;

/** `useState` that survives a reload of the page: the value is kept while it differs from `initial`. */
export function useKeptState<T extends string | boolean | number>(key: string, initial: T): [Widen<T>, (v: Widen<T>) => void] {
  const [value, setValue] = useState<Widen<T>>(() => read<Widen<T>>(key) ?? (initial as unknown as Widen<T>));
  useEffect(() => write(key, (value as unknown) === initial ? undefined : value), [key, value, initial]);
  return [value, setValue];
}

/** Savers the page runs just before it reloads for a new version. */
const savers = new Set<() => void>();

/** Register a function that writes the page's place somewhere a reload keeps. Returns its removal. */
export function onPageSave(fn: () => void): () => void {
  savers.add(fn);
  return () => void savers.delete(fn);
}

export function savePage() {
  savers.forEach((fn) => {
    try {
      fn();
    } catch {
      /* one saver failing does not stop the others */
    }
  });
}

if (typeof window !== 'undefined') onPageSave(saveFocus);

/**
 * A Map of places (a chat's scroll position, a list's) that a reload gives back: read from this tab's storage now, written
 * soon after each change and in savePage. Not on `pagehide`: a listener there runs before the composer's own, and the
 * microtasks between them let a message cut off by the reload put its text back into the box first (composerClears.spec.ts).
 */
export function keptMap<V>(name: string): Map<string, V> {
  const flush = () => write(name, map.size ? Object.fromEntries(map) : undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  class Kept extends Map<string, V> {
    override set(key: string, value: V) {
      super.set(key, value);
      clearTimeout(timer);
      timer = setTimeout(flush, 300);
      return this;
    }
  }
  const map = new Kept(Object.entries(read<Record<string, V>>(name) ?? {}));
  onPageSave(flush);
  return map;
}

// ---- the caret: which message box had it ----

const FOCUS = 'focus';

/** Note which message box had the focus, for the page that replaces this one (the caret goes to the end of the draft). */
function saveFocus() {
  const a = document.activeElement as HTMLElement | null;
  const box = a?.closest<HTMLElement>('[data-keep-focus]');
  write(FOCUS, box ? box.dataset.keepFocus : undefined);
}

/** Whether the caret was in the box named `key` when the previous page went; true once, then the note is gone. */
export function takeFocus(key: string): boolean {
  if (read<string>(FOCUS) !== key) return false;
  write(FOCUS, undefined);
  return true;
}
