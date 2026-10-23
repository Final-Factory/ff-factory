// What a card on the Waiting on input and Intake tabs asks (w1597). Ben, 2026-10-20: "I never know what its asking. so much
// text is devoted to stuff that is not relevant I'm never going to look at files at the /srv/ path, they must be previews.
// and theres so much information like pull request that i dont care about. just ask the question clearly, give me the
// option selections and thats it".
//
// A card shows the request's title, one question at a time, its 2-4 answers as buttons (the recommended one first and
// marked) with a box for a free answer, and its stills and clips as previews. Everything else sits behind one Details link.
// Whoever writes a question for a person (a worker's waiting_on_person, the dispatcher's decide_work ask) gives it as
// questions with options (checkAsks); a question written before that (free text) is shown cleaned (plainQuestion) with the
// free answer box alone. No imports from the page or the server, so both and `node --test` load it.
import { checkAsk, splitMedia, type Ask } from './ask.ts';
import type { WorkItem } from './types.ts';

/** At most this many questions in one wait: a card with several shows them one at a time. */
export const MAX_ASKS = 6;
/** The words of a card's question, at most: one sentence a person reads without opening anything. */
export const CARD_QUESTION_CHARS = 300;

/** An absolute path in words (a review file, a temp folder): it goes in as media, never as text. */
const ABS_PATH = /(?:^|[\s(`'"])(?:\/(?:srv|home|Users|tmp|var|opt|mnt)\/|[A-Za-z]:[\\/])[^\s`'")]+/;
/** A pull request or issue number ("#1873"). */
const PR_REF = /(?:^|[^\w&])#\d{3,6}\b/g;
/** A worker or session id ("worker dafd0fe0"). */
const SESSION_ID = /\b(?:worker|session)\s+[0-9a-f]{8}\b/i;

/** What is wrong with a question's or an answer's words for a card, or undefined (w1597: no paths, PR lists or ids). */
export function wordsProblem(s: string, what: string): string | undefined {
  const words = splitMedia(s).text;
  if (ABS_PATH.test(words)) return `${what}: no file paths in the words; give a still or clip as ![what it shows](<absolute path>) and leave reports out (they go in your report)`;
  if ((words.match(PR_REF) ?? []).length > 1) return `${what}: no lists of pull requests; say in plain words what each choice does for players (the PRs go in your report)`;
  if (SESSION_ID.test(words)) return `${what}: no worker or session ids; say what is asked in plain words`;
  return undefined;
}

/**
 * The questions a worker or the dispatcher gives (waiting_on_person questions, decide_work ask questions) as Asks, or what is
 * wrong with them: 1 to MAX_ASKS, each one question of at most CARD_QUESTION_CHARS words with 2 to 4 answers (shared/ask.ts
 * checkAsk: the recommended one first), none naming a file path, a list of pull requests or a worker id.
 */
export function checkAsks(input: unknown): { asks: Ask[] } | { problem: string } {
  if (!Array.isArray(input) || input.length < 1) return { problem: 'questions: at least one question with its 2 to 4 answers' };
  if (input.length > MAX_ASKS) return { problem: `questions: at most ${MAX_ASKS}; ask the rest after these are answered` };
  const asks: Ask[] = [];
  for (const [i, raw] of input.entries()) {
    const n = input.length > 1 ? `question ${i + 1}` : 'question';
    const c = checkAsk(raw);
    if ('problem' in c) return { problem: `${n}: ${c.problem}` };
    if (splitMedia(c.ask.question).text.length > CARD_QUESTION_CHARS) return { problem: `${n}: at most ${CARD_QUESTION_CHARS} characters of words: one plain sentence (the detail goes in your report)` };
    const bad = wordsProblem(c.ask.question, n) ?? c.ask.options.map((o, j) => wordsProblem(`${o.label} ${o.description ?? ""}`, `${n}, answer ${j + 1}`)).find(Boolean);
    if (bad) return { problem: bad };
    asks.push(c.ask);
  }
  return { asks };
}

/**
 * A free-text question written before w1597, cleaned for a card: its media out (shown as previews), file paths and the
 * words that point at them ("from /srv/…/REPORT.md") out, brackets that only list pull requests out, worker ids as
 * "its worker". What is left is shown as the question, with the free answer box.
 */
export function plainQuestion(text: string): string {
  return splitMedia(text)
    .text.replace(/\s*\b(?:from|in|at|see)\s+`?(?:\/|[A-Za-z]:[\\/])[^\s`]+`?/gi, '')
    .replace(/`?(?:\/(?:srv|home|Users|tmp|var|opt|mnt)\/|[A-Za-z]:[\\/])[^\s`)]+`?/g, '')
    .replace(/\s*\([^()]*#\d{3,6}[^()]*\)/g, '')
    .replace(/\b(?:worker|session)\s+[0-9a-f]{8}\b/gi, 'its worker')
    .replace(/\s+([,.;:?!])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Absolute paths in Details text shown as their file names (w1597: no /srv path as text on a card). A Markdown image keeps
 * its target: it is shown as the still, not as text.
 */
export const namesForPaths = (s: string) =>
  s.replace(/(!\[[^\]\n]*\]\(\s*(?:<[^>\n]+>|[^\s)]+)[^)\n]*\))|`?((?:\/(?:srv|home|Users|tmp|var|opt|mnt)\/|[A-Za-z]:[\\/])(?:[^\s`)\]<]|<[^>\n]*>)*)`?/g, (_all, img?: string, path?: string) => {
    if (img) return img;
    // Trailing punctuation stays text; a file is its name, a folder its last real name (never a "<request id>" placeholder).
    const tail = /[:;,.]+$/.exec(path!)?.[0] ?? '';
    const parts = path!.slice(0, path!.length - tail.length).split(/[\\/]/).filter((x) => x && !x.startsWith('<'));
    const last = parts[parts.length - 1] ?? '';
    return `\`${last}${last.includes('.') ? '' : '/'}\`${tail}`;
  });

/**
 * A free-text question that lists decisions ("Decide A, B, C and D."), as one question per decision, each answered in words:
 * the card asks them one at a time like structured ones (w1597 critic: six topics under one box is what Ben could not parse).
 * Undefined when it is not such a list (fewer than three items, or one too long to be a topic).
 */
export function legacySteps(q: string): Ask[] | undefined {
  const m = /^((?:Decide|Choose|Pick|Confirm|Say)\b[^:,]{0,40}?)(?::\s*|\s+)(.+)$/i.exec(q.trim());
  if (!m) return undefined;
  const items = m[2]
    .replace(/[.]\s*$/, '')
    .split(/,\s*(?:and\s+)?|\s+and\s+(?=[^,]*$)/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (items.length < 3 || items.some((x) => x.length > 90)) return undefined;
  const verb = m[1].trim().replace(/^\w/, (c) => c.toUpperCase());
  return items.map((x) => ({ question: `${verb}: ${x}`, options: [] }));
}

/** Which questions a waiting request's card asks: the structured ones it was given, or its free-text question cleaned. */
export interface CardQuestions {
  /** Structured questions with answers, shown one at a time. Empty: `text` is the question, answered in words. */
  asks: Ask[];
  /** The question, cleaned, when there are no structured ones. */
  text: string;
  /** Who asks (the worker that resumes with the answer), for the Details line. */
  worker?: string;
}

/** The question a request that waits on its person's answer asks (not an intake approval: the card asks that itself). */
export function cardQuestions(w: Pick<WorkItem, 'needsYou' | 'question' | 'flag'>): CardQuestions {
  const r = w.needsYou && !w.needsYou.answered ? w.needsYou : undefined;
  // w1868: of several questions, the ones a note answered already are not asked again.
  const open = (r?.asks ?? []).filter((_, i) => !(r?.answeredAsks ?? []).includes(i));
  if (open.length) return { asks: open, text: '', ...(r?.worker ? { worker: r.worker } : {}) };
  if (w.question?.asks?.length && (!r || r.kind === 'question')) return { asks: w.question.asks, text: '' };
  // A worker's own words come first: the dispatcher's question folded into it is its restatement (Details).
  const raw = r && r.kind !== 'question' ? r.question : (w.question?.text ?? w.flag?.text ?? r?.question ?? '');
  return { asks: [], text: plainQuestion(raw), ...(r?.worker ? { worker: r.worker } : {}) };
}

/**
 * The answers to a card's questions as one message's words: the label of the one picked (or what was typed) for a single
 * question; a numbered list, each question with its answer, for several.
 */
export function answersText(asks: readonly Ask[], answers: readonly string[]): string {
  if (asks.length <= 1) return (answers[0] ?? '').trim();
  return asks.map((a, i) => `${i + 1}. ${splitMedia(a.question).text}\n   ${(answers[i] ?? '').trim()}`).join('\n');
}

/**
 * The message that carries a person's answer to their own orchestrator, which records it on the request (update_work note):
 * FF Factory then resumes the worker that waits on it (server/orchestrators.ts answerNeedsYou). A click on an answer and a
 * typed answer send this same message (w1597).
 */
export function answerMessage(w: Pick<WorkItem, 'id' | 'title' | 'question' | 'flag' | 'needsYou'>, text: string): string {
  const asked = w.needsYou?.asks?.length
    ? w.needsYou.asks.filter((_, i) => !(w.needsYou?.answeredAsks ?? []).includes(i)).map((a) => splitMedia(a.question).text).join(' / ')
    : w.question?.asks?.length
      ? w.question.asks.map((a) => splitMedia(a.question).text).join(' / ')
      : (w.question?.text ?? w.flag?.text ?? w.needsYou?.question ?? '');
  return `Answer on ${w.id} (${w.title}). It asked: “${asked.slice(0, 300)}”\n\n${text}\n\nPlease put this on ${w.id} as my answer (update_work note).`;
}

/** The stills and clips a card previews: the question's own media first, then the review files the wait names. */
export function cardMedia(ask: Ask | undefined, previews: readonly string[]): { url: string; alt: string }[] {
  const out: { url: string; alt: string }[] = [];
  const add = (url: string, alt: string) => {
    if (url && !url.includes('*') && /\.(?:png|jpe?g|gif|webp|mp4|m4v|webm|mov)$/i.test(url) && !out.some((m) => m.url === url)) out.push({ url, alt });
  };
  for (const m of ask ? splitMedia(ask.question).media : []) add(m.url, m.alt);
  for (const p of previews) add(p, p.split(/[\\/]/).pop() ?? p);
  return out.slice(0, 8);
}
