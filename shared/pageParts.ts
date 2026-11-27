// The parts of a page's state a reconnect need not resend (w6336). Sessions have their own delta (w5907, pageSessions.ts);
// the rest of a state (2.5 MB on lothsahn's reconnects on 2026-11-27, 1-3 s over Funnel) went whole on every reconnect.
// The page sends a hash of each part it holds, and of each request in `work` (`parts` on /ws); the server leaves out
// every part, and every request, whose JSON hashes the same now, and says which (AppState.partsKept, workDelta). The
// hash is of the page's own copy as it stands, the live events laid on it, so a part the events left behind is sent.
import type { AppState, WorkItem } from './types.ts';

/** The whole parts a page may keep: the biggest after sessions and work (server/pageState.ts stateSizes). */
export const KEPT_PARTS = ['reports', 'machines', 'delegations', 'accounts', 'standingAgents'] as const;
export type KeptPart = (typeof KEPT_PARTS)[number];

/** The longest `parts` a server reads: 100 requests at about 18 characters each, and the whole parts. */
export const PARTS_HAVE_MAX = 4096;

/** A 53-bit hash of a string (cyrb53), in base 36: the same on the page and the server for the same JSON. */
export function hashText(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * hashText by the JSON it hashes, for the parts and requests seen lately (w6382): a reconnect's parts are mostly as they
 * were, and the server's cyrb53 of them took 25-48 ms of each state build on the portal (stall profiles 2026-11-27 14:31Z).
 * A Map finds a long string by its length and contents, natively. Emptied when the JSON it holds passes HASH_MEMO_CHARS
 * (one reconnect's parts were about 700 KB), so parts that changed long ago do not pile up, here or on the page.
 */
const hashMemo = new Map<string, string>();
let hashMemoChars = 0;
export const HASH_MEMO_CHARS = 4_000_000;
export function hashOf(v: unknown): string {
  const s = JSON.stringify(v ?? null);
  let h = hashMemo.get(s);
  if (h === undefined) {
    h = hashText(s);
    if (hashMemoChars + s.length > HASH_MEMO_CHARS) {
      hashMemo.clear();
      hashMemoChars = 0;
    }
    hashMemo.set(s, h);
    hashMemoChars += s.length;
  }
  return h;
}

/** What a reconnecting page sends as `parts`: `reports:<hash>;...;work:<id>=<hash>,...`. Undefined when it has no state. */
export function partsHave(app: AppState | null | undefined): string | undefined {
  if (!app) return undefined;
  const out: string[] = [];
  for (const k of KEPT_PARTS) if (app[k] !== undefined) out.push(`${k}:${hashOf(app[k])}`);
  // The requests only while they fit (a page that gathered many from events then gets them all).
  const work = app.work?.length ? `work:${app.work.map((w) => `${w.id}=${hashOf(w)}`).join(',')}` : '';
  if (work && out.join(';').length + work.length < PARTS_HAVE_MAX) out.push(work);
  return out.length ? out.join(';') : undefined;
}

/** A page's `parts`, read: the whole parts' hashes and the requests'. Anything malformed is left out (it is then sent). */
export function readPartsHave(raw: string | null | undefined): { parts: Map<string, string>; work: Map<string, string> } {
  const parts = new Map<string, string>();
  const work = new Map<string, string>();
  if (!raw || raw.length > PARTS_HAVE_MAX) return { parts, work };
  for (const piece of raw.split(';')) {
    const i = piece.indexOf(':');
    if (i <= 0) continue;
    const k = piece.slice(0, i);
    const v = piece.slice(i + 1);
    if (k === 'work') {
      for (const pair of v.split(',')) {
        const m = /^([\w-]{1,40})=([a-z0-9]{1,12})$/.exec(pair);
        if (m) work.set(m[1], m[2]);
      }
    } else if ((KEPT_PARTS as readonly string[]).includes(k) && /^[a-z0-9]{1,12}$/.test(v)) parts.set(k, v);
  }
  return { parts, work };
}

/**
 * The server's side: `state` (built whole) less what the page said it holds unchanged. Kept parts are deleted from it
 * and named in `partsKept`; unchanged requests are left out of `work`, and `workDelta.ids` lists every request in order.
 */
export function dropKeptParts(state: AppState, raw: string | null | undefined): AppState {
  const have = readPartsHave(raw);
  if (!have.parts.size && !have.work.size) return state;
  const out: AppState = { ...state };
  const kept: KeptPart[] = [];
  for (const k of KEPT_PARTS) {
    const h = have.parts.get(k);
    if (h !== undefined && state[k] !== undefined && hashOf(state[k]) === h) {
      delete (out as Partial<AppState>)[k];
      kept.push(k);
    }
  }
  if (kept.length) out.partsKept = kept;
  if (have.work.size && state.work) {
    const changed = state.work.filter((w) => have.work.get(w.id) !== hashOf(w));
    if (changed.length < state.work.length) {
      out.work = changed;
      out.workDelta = { ids: state.work.map((w) => w.id) };
    }
  }
  return out;
}

/**
 * The page's side: `next` with what it left out filled from the page's own state `had`. Undefined when `next` names a
 * part or a request the page has no copy of (cannot happen: it named only what it held): the page then fetches it all.
 */
export function fillKeptParts(had: AppState | null | undefined, next: AppState): AppState | undefined {
  if (!next.partsKept && !next.workDelta) return next;
  if (!had) return undefined;
  const out: AppState = { ...next, partsKept: undefined, workDelta: undefined };
  const into = out as unknown as Record<string, unknown>;
  for (const k of next.partsKept ?? []) {
    if (had[k] === undefined) return undefined;
    into[k] = had[k];
  }
  if (next.workDelta) {
    const byId = new Map<string, WorkItem>((had.work ?? []).map((w) => [w.id, w]));
    for (const w of next.work ?? []) byId.set(w.id, w);
    const work: WorkItem[] = [];
    for (const id of next.workDelta.ids) {
      const w = byId.get(id);
      if (!w) return undefined;
      work.push(w);
    }
    out.work = work;
  }
  return out;
}
