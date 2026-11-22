// What transcript search matches and shows (server/search.ts), apart from the search itself so the index's worker thread
// (server/searchWorker.ts) loads it without the portal's secrets module: snippets are masked on the main thread.
import type { TranscriptEvent } from '../shared/types.ts';
import { personMessageView } from '../shared/personMessage.ts';

/** Split a query into lower-case terms, keeping "quoted phrases" whole. Exported for tests. */
export function terms(q: string): string[] {
  const out: string[] = [];
  for (const m of q.matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] ?? m[2]).trim().toLowerCase();
    if (t) out.push(t);
  }
  return out;
}

/** The raw-line prefilter's words: single words, since a phrase's words may sit around an escaped newline; words with a quote or backslash are left out, JSON escapes them. */
export function prefilterParts(words: string[]): string[] {
  return [...new Set(words.flatMap((w) => w.split(' ')))].filter((w) => w && !/["\\]/.test(w));
}

/** The text of an event that search looks at. */
export function searchableText(e: TranscriptEvent): string {
  switch (e.kind) {
    case 'user':
      // A person's message is searched as their chat shows it: FF Factory's notes after their words are the orchestrator's (w3581).
      return e.from === 'human' ? personMessageView(e.text).words : e.text;
    case 'assistant':
    case 'thinking':
    case 'system':
    case 'error':
    case 'result':
      return e.text;
    case 'tool_use':
      return `${e.name} ${JSON.stringify(e.input)}`;
    case 'tool_result':
      return e.text;
    case 'permission':
      return `${e.toolName} ${JSON.stringify(e.input)}`;
  }
}

/** ~160 characters around the first term, on one line. */
export function snippet(text: string, words: string[]): string {
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  const at = Math.max(0, lower.indexOf(words[0] ?? ''));
  const start = Math.max(0, at - 70);
  const end = Math.min(flat.length, at + (words[0]?.length ?? 0) + 90);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * One transcript line tested as search always has: the raw line must hold every prefilter part (cheap, before parsing),
 * then the event must fall in [since, until] (an event whose time does not parse passes, as before) and its searchable
 * text hold every term. Returns the event, or undefined.
 */
export function matchLine(line: string, words: string[], parts: string[], since: number, until: number): TranscriptEvent | undefined {
  if (!line) return undefined;
  const lower = line.toLowerCase();
  if (!parts.every((w) => lower.includes(w))) return undefined;
  let e: TranscriptEvent;
  try {
    e = JSON.parse(line);
  } catch {
    return undefined;
  }
  const t = Date.parse(e.t);
  if (t < since || t > until) return undefined;
  const tl = (searchableText(e) ?? '').replace(/\s+/g, ' ').toLowerCase();
  return words.every((w) => tl.includes(w)) ? e : undefined;
}
