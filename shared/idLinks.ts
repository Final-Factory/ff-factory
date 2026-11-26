/**
 * Clickable ids in an orchestrator's chat (w6216): a worker's session id ("b6c73b2b", or the whole UUID), a sandbox
 * ("beast/agent4"), a machine ("BEAST") and a request ("w6215") an orchestrator names become links to their page in
 * the dashboard's right panel.
 *
 * The renderer links them, not the orchestrators: every orchestrator already writes these ids as plain words (its
 * briefs ask for them, and the server's own notices print `worker ${id.slice(0, 8)}`), so linking what is written works
 * for every past message and every instance with no brief change, and nothing breaks when an orchestrator forgets a link
 * syntax. Only ids this page knows are linked: a word is a candidate by its shape (isIdCandidate), and a link only
 * once resolveIdToken finds exactly one session, sandbox, machine or ledger item for it; random hex, a short prefix two
 * sessions share, and ordinary words stay text. Nothing here is game-specific: the ids come from the page's own state.
 *
 * Pure and dependency-free, so the server's node tests check it (server/idLinks.test.ts) and the web uses it as is
 * (web/src/components/IdLink.tsx).
 */

/** What a linked id opens. */
export type IdTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'sandbox'; machineId: string; sandboxId: string }
  | { kind: 'machine'; machineId: string }
  | { kind: 'request'; id: string };

/** The ids a page knows, from its state. Build it once per state (idIndex caches it by the lists it was made from). */
export interface IdIndex {
  /** Session id prefixes of 8 characters to the one session that has it, or null when two or more share it. */
  prefixes: Map<string, string | null>;
  /** Every whole session id. */
  sessions: Set<string>;
  /** Machine ids (lower case) to their id. */
  machines: Map<string, string>;
  /** The words that name a machine as written: its id, its typed name ("LothDesktop") and the id in capitals ("BEAST"). */
  machineWords: Map<string, string>;
  /** "<machine id>/<sandbox id>", lower case, to the pair. */
  sandboxes: Map<string, { machineId: string; sandboxId: string }>;
  /** Ledger ids ("w6215"). */
  requests: Set<string>;
}

export interface IdSources {
  sessions: readonly { id: string }[];
  machines: readonly { id: string; name?: string; sandboxes?: readonly { id: string }[] }[];
  work?: readonly { id: string }[];
}

export function buildIdIndex(src: IdSources): IdIndex {
  const prefixes = new Map<string, string | null>();
  const sessions = new Set<string>();
  for (const s of src.sessions) {
    const id = s.id.toLowerCase();
    sessions.add(id);
    if (id.length < 8) continue;
    const p = id.slice(0, 8);
    prefixes.set(p, prefixes.has(p) && prefixes.get(p) !== s.id ? null : s.id);
  }
  const machines = new Map<string, string>();
  const machineWords = new Map<string, string>();
  const sandboxes = new Map<string, { machineId: string; sandboxId: string }>();
  for (const m of src.machines) {
    machines.set(m.id.toLowerCase(), m.id);
    for (const w of [m.id, m.name, m.id.toUpperCase()]) if (w) machineWords.set(w, m.id);
    for (const sb of m.sandboxes ?? []) sandboxes.set(`${m.id}/${sb.id}`.toLowerCase(), { machineId: m.id, sandboxId: sb.id });
  }
  return { prefixes, sessions, machines, machineWords, sandboxes, requests: new Set((src.work ?? []).map((w) => w.id)) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX8 = /^[0-9a-f]{8}$/i;
const REQUEST = /^w\d+$/;
const SANDBOX = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;

/**
 * A word, or a "machine/sandbox" pair, standing on its own: not inside a path, a URL, an instance name ("slot2@4a15d577"),
 * a dotted name or a "#123" number. Its characters are those of every id above; the class around it keeps the edges.
 */
const TOKEN = /(?<![\w/.@#:-])[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?(?![\w/@-])/g;

/** What a token links to on this page, or undefined: it stays text. */
export function resolveIdToken(token: string, ix: IdIndex): IdTarget | undefined {
  if (SANDBOX.test(token)) {
    const sb = ix.sandboxes.get(token.toLowerCase());
    return sb && { kind: 'sandbox', ...sb };
  }
  if (REQUEST.test(token)) return ix.requests.has(token) ? { kind: 'request', id: token } : undefined;
  if (UUID.test(token)) {
    // A whole id is the session's own (the page's ids are lower-case UUIDs), or nothing.
    const id = token.toLowerCase();
    return ix.sessions.has(id) ? { kind: 'session', sessionId: ix.prefixes.get(id.slice(0, 8)) ?? id } : undefined;
  }
  if (HEX8.test(token)) {
    // An 8-character prefix links only to the one session it names; two that share it, or none, leave it text.
    const id = ix.prefixes.get(token.toLowerCase());
    return id ? { kind: 'session', sessionId: id } : undefined;
  }
  const m = ix.machineWords.get(token);
  return m ? { kind: 'machine', machineId: m } : undefined;
}

/**
 * Could this word be an id, by its shape alone: a machine/sandbox pair, a request, a session id or prefix, or one of
 * `machineWords`. The renderer wraps only these (web/src/components/IdLink.tsx), and each resolves itself against the
 * page's live state, so a message is not drawn again for every session that starts.
 */
export function isIdCandidate(token: string, machineWords: { has(w: string): boolean }): boolean {
  return SANDBOX.test(token) || REQUEST.test(token) || UUID.test(token) || HEX8.test(token) || machineWords.has(token);
}

/** A run of text: plain, or a token `pick` chose, with what it gave for it. */
export type TokenSegment<T> = { text: string; hit?: T };

/** The text cut at each token `pick` gives a value for, in order; the texts joined give the input back. */
export function splitTokens<T>(text: string, pick: (token: string) => T | undefined): TokenSegment<T>[] {
  const out: TokenSegment<T>[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    const hit = pick(m[0]);
    if (hit === undefined) continue;
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: m[0], hit });
    at = m.index + m[0].length;
  }
  if (at < text.length || !out.length) out.push({ text: text.slice(at) });
  return out;
}

/** The text cut at each id this page knows, with what each opens. */
export function idSegments(text: string, ix: IdIndex): TokenSegment<IdTarget>[] {
  return splitTokens(text, (t) => resolveIdToken(t, ix));
}

/** A node of the rendered markdown's tree (hast), as much of it as linking needs. */
export interface IdHastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: IdHastNode[];
}

/** Elements whose text is never linked: a link already, code, a code block, a key, a diagram's source. */
const SKIP = new Set(['a', 'code', 'pre', 'kbd', 'samp', 'script', 'style']);

/**
 * Replace the tokens in a rendered message's tree that `wrap` gives a node for, in place: every text node outside SKIP
 * (links, inline code, code blocks) is cut by splitTokens. The web wraps each candidate id in a span that resolves itself.
 */
export function linkIdsInTree(tree: IdHastNode, wrap: (token: string) => IdHastNode | undefined): void {
  const walk = (node: IdHastNode) => {
    if (!node.children) return;
    const next: IdHastNode[] = [];
    let changed = false;
    for (const child of node.children) {
      if (child.type === 'element' && SKIP.has(child.tagName ?? '')) {
        next.push(child);
        continue;
      }
      if (child.type !== 'text' || !child.value) {
        walk(child);
        next.push(child);
        continue;
      }
      const segs = splitTokens(child.value, wrap);
      if (segs.length === 1 && !segs[0].hit) {
        next.push(child);
        continue;
      }
      for (const s of segs) next.push(s.hit ?? { type: 'text', value: s.text });
      changed = true;
    }
    if (changed) node.children = next;
  };
  walk(tree);
}
