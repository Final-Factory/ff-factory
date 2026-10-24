// A person's earlier decisions on a request, read before anyone asks them something new (w2085, the w2084 lesson; Ben,
// 2026-10-24: "i already answered this. you keep asking me questions i already answered"). w1812 holds back the SAME question
// once answered; this covers a NEW question that a decision they made earlier already settles: on w1958 Ben decided the
// low-ore alert's wording at 04:59 ("Right-click dismisses for a while; shift+right-click silences for good"), and at 16:32
// a fresh-session worker asked him whether game PR #2395, which only added that line to a tooltip, could merge as it looked.
//
// Three uses (docs/orchestrators.md, "Questions for a person"):
// - the `[needs you]` card carries that person's notes on the request and its related requests, flagged "possibly decided"
//   when one names the same pull request or thread, or the same feature term (Orchestrators.placeNeedsYou);
// - the fresh session after a merge (w2043) is told its people's notes are decisions, with those of its related requests;
// - waiting_on_person refuses a look or merge OK for a pull request whose added text one of their notes quotes (Agents).
// The pure parts are here.
import type { WorkItem } from '../shared/types.ts';

/** One note a person left, and the request it is on. */
export interface PriorNote {
  on: string;
  at: string;
  by: string;
  text: string;
}

/** Why a note may already decide a question: what it names that the question names too. */
export interface PossiblyDecided {
  on: string;
  at: string;
  by: string;
  why: string[];
}

/** At most this many notes go on a card or in a hand-off (the newest), each cut to NOTE_CHARS. */
export const MAX_PRIOR_NOTES = 8;
export const NOTE_CHARS = 900;
/** A quote that decides the added text has at least this many content words, this share of them in the added text. */
const QUOTE_MIN_WORDS = 4;
const QUOTE_COVER = 0.8;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** The first word of a name, case aside: "Ben (or his orchestrator)" is "ben" (shared/workState.ts personKey). */
export const personKey = (name: string) => name.trim().toLowerCase().split(/[\s(,]/)[0];

/**
 * The requests whose people's notes count with `w`'s: the ones it names (relatedIds), the ones that name it, and `also`
 * (the other requests its worker holds), each once, `w` first.
 */
export function relatedRequests(w: Pick<WorkItem, 'id' | 'relatedIds'>, items: Iterable<WorkItem>, also: readonly Pick<WorkItem, 'id'>[] = []): WorkItem[] {
  const all = [...items];
  const named = new Set((w.relatedIds ?? []).map((r) => r.trim().toLowerCase()));
  const out: WorkItem[] = [];
  const self = all.find((x) => x.id === w.id);
  if (self) out.push(self);
  for (const x of all) {
    if (x.id === w.id || out.includes(x)) continue;
    if (named.has(x.id) || (x.relatedIds ?? []).some((r) => r.trim().toLowerCase() === w.id) || also.some((a) => a.id === x.id)) out.push(x);
  }
  return out;
}

/** The notes of `who` (names: display names or user ids) on `items`, oldest first; the newest MAX_PRIOR_NOTES, each cut. */
export function personNotes(items: readonly Pick<WorkItem, 'id' | 'notes'>[], who: readonly string[]): PriorNote[] {
  const people = new Set(who.map(personKey).filter(Boolean));
  const all = items.flatMap((x) => (x.notes ?? []).filter((n) => people.has(personKey(n.by))).map((n) => ({ on: x.id, at: n.at, by: n.by, text: n.text })));
  return all
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-MAX_PRIOR_NOTES)
    .map((n) => ({ ...n, text: clip(n.text.trim(), NOTE_CHARS) }));
}

/** Words that say nothing about which feature a text is about. */
const STOP = new Set(
  (
    'a an and are as at be but by can do does for from go has have he his how i if in is it its look looks looked merge merged merging ' +
    'me my no not now of ok okay on or our please pr pull request say says should so still stills that the their them then there these ' +
    'they this those to too up us was we what when where whether which while who why will with would yes you your before after change ' +
    'changes changed already answer answers answered question questions ask asked ben shot shots screenshot image images clip clips ' +
    'build built game player players its make made need needs new old one two three four five also only just like want into about ' +
    'over under same other each every some any all than more less very much way time once again first last next good fine right left'
  ).split(' '),
);

/** A text's words, lowercased, apostrophes and possessives off. */
function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The words of a text that carry meaning: not stop words, two letters or more. */
export function contentWords(s: string): string[] {
  return words(s).filter((x) => x.length >= 2 && !STOP.has(x));
}

/** The hyphenated terms of a text, lowercased ("low-ore", "right-click"): the most telling names a feature has. */
function terms(s: string): string[] {
  return [...s.toLowerCase().matchAll(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g)].map((m) => m[0]);
}

/** The quoted phrases of a note (“…”, "…") with at least QUOTE_MIN_WORDS content words: words the person decided. */
export function quotedPhrases(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[“"]([^“”"]{8,600})[”"]/g)) {
    const q = m[1].trim();
    if (contentWords(q).length >= QUOTE_MIN_WORDS && !out.includes(q)) out.push(q);
  }
  return out;
}

/** The lines a unified diff adds, without their "+" (the "+++" file headers left out). */
export function addedLines(diff: string): string {
  return diff
    .split(/\r?\n/)
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n');
}

/**
 * The quote of `note` that the added text carries (QUOTE_COVER of its content words are in it), or undefined. Words, not
 * the exact string: a pull request words a decision its own way ("Hold Shift and right click ..."), and often quotes the
 * person in a comment beside it, as #2395 did.
 */
export function quoteCovered(note: string, added: string): string | undefined {
  const have = new Set(contentWords(added));
  if (!have.size) return undefined;
  for (const q of quotedPhrases(note)) {
    const ws = [...new Set(contentWords(q))];
    if (ws.filter((x) => have.has(x)).length >= QUOTE_COVER * ws.length) return q;
  }
  return undefined;
}

/** The pull request numbers, thread ids and feature terms a question names. */
export interface QuestionRefs {
  prs: string[];
  threads: string[];
  text: string;
}

/** The refs of a question's texts, with the pull requests it is about ("owner/repo#123" or "#123"). */
export function questionRefs(texts: readonly (string | undefined)[], prs: readonly string[]): QuestionRefs {
  const text = texts.filter(Boolean).join('\n');
  const threads = [...new Set([...text.matchAll(/\bthread\s+#?(\d{3,})\b/gi), ...text.matchAll(/discord\.com\/channels\/\d+\/(\d+)/g)].map((m) => m[1]))];
  return { prs: [...new Set(prs.map((p) => p.replace(/^.*#/, '')))], threads, text };
}

/**
 * Why `note` may already decide the question (empty when nothing shows it): it names one of its pull requests or threads,
 * or a hyphenated term of it, or two of its other content words of five letters or more. A flag for the orchestrator to
 * confirm before it asks, never an answer.
 */
export function possiblyDecides(note: string, refs: QuestionRefs): string[] {
  const why: string[] = [];
  for (const n of refs.prs) if (new RegExp(`(^|[^\\w/])#${n}\\b|/pull/${n}\\b`).test(note)) why.push(`PR #${n}`);
  for (const t of refs.threads) if (new RegExp(`\\bthread\\s+#?${t}\\b|/${t}\\b`, 'i').test(note)) why.push(`thread ${t}`);
  const qTerms = new Set(terms(refs.text));
  const shared = [...new Set(terms(note))].filter((t) => qTerms.has(t));
  for (const t of shared) why.push(`"${t}"`);
  if (!shared.length) {
    const qWords = new Set(contentWords(refs.text).filter((x) => x.length >= 5));
    const both = [...new Set(contentWords(note).filter((x) => x.length >= 5 && qWords.has(x)))];
    if (both.length >= 2) why.push(`"${both.slice(0, 3).join('", "')}"`);
  }
  return why;
}

/** The notes that may decide the question, with why, oldest first. */
export function possiblyDecided(notes: readonly PriorNote[], refs: QuestionRefs): PossiblyDecided[] {
  return notes.flatMap((n) => {
    const why = possiblyDecides(n.text, refs);
    return why.length ? [{ on: n.on, at: n.at, by: n.by, why }] : [];
  });
}

/** Whether a question asks for a look or merge OK ("can it merge as it looks?", "OK the stills"), not a design choice. */
export function asksLookOk(texts: readonly (string | undefined)[]): boolean {
  const t = texts.filter(Boolean).join('\n');
  return /\b(merge|merged|ship|ships|approve|approval|sign[- ]?off|ok|okay)\b/i.test(t) || /\bas it looks\b|\blooks? (right|good|ok)\b/i.test(t);
}

/** "04:59 UTC on w1958" for a note. */
export const noteWhen = (n: Pick<PriorNote, 'at' | 'on'>, self?: string) => `${n.at.slice(0, 16).replace('T', ' ')} UTC${n.on !== self ? ` on ${n.on}` : ''}`;

/** The line a note takes on a card or in a hand-off. */
export const noteLine = (n: PriorNote, self?: string) => `- ${noteWhen(n, self)}, ${n.by}: ${n.text.replace(/\s*\n\s*/g, ' ')}`;

/** The refusal waiting_on_person answers when a note of theirs decided what the pull request adds (w2085). */
export function decidedRefusal(n: PriorNote, quote: string, pr: string, self?: string): string {
  return (
    `Not recorded: ${n.by} already decided what ${pr} adds. Their note at ${noteWhen(n, self)}: "${n.text.replace(/\s*\n\s*/g, ' ')}". It says "${quote}", and ${pr} adds that text. ` +
    `A UI change whose content they decided (their wording or behaviour as plain text in an existing component, nothing else moved) gets no separate look OK: quote the note in the PR's Evidence (Decided (${n.by}, ${n.at.slice(0, 10)}): "${quote}") and merge it on green (evidence-gate, "A decided UI change gets no look OK", w2084). ` +
    `If your question asks something that note does not settle (a new component, a layout change, art, or a choice it leaves open), call waiting_on_person again with decided_override saying what it leaves open.`
  );
}
