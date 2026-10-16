// A question the orchestrator asks its person with buttons (w1397; docs/orchestrators.md, "Questions with buttons").
// Ben, 2026-10-16: "when you are asking me questions lets do it like claude code where you give whatever your recommended
// options are (saying which one you most prefer) and then a 'chat more about this' option. make a button for each to accept
// that answer then just use it instead of me having to type".
//
// The orchestrator calls its `ask_person` tool; the call stays in the transcript as a tool_use event, and the page draws
// that event as the question with one button per option (the recommended one first) and a last "Chat more about this".
// A click is sent as the person's own reply to that event (shared/replies.ts: their words are the option's label, then
// FF Factory's mark and the question quoted), so it reads, gates and renders like a reply they typed. The buttons lock by
// reading the transcript: a message of the person's that quotes this event is the answer. No imports from the page or the
// server, so both and `node --test` load it.
import { splitReply } from './replies.ts';

/** The tool's name; the transcript shows it as `mcp__<server>__ask_person`. */
export const ASK_TOOL = 'ask_person';

/** Whether a tool_use event's name is the question tool. */
export const isAskTool = (name: string) => name === ASK_TOOL || name.endsWith(`__${ASK_TOOL}`);

/** The option that never answers: it opens the person's reply box on the question. Added by the page, never sent. */
export const CHAT_MORE_LABEL = 'Chat more about this';
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const QUESTION_CHARS = 600;
export const LABEL_CHARS = 90;
export const DESCRIPTION_CHARS = 220;

export interface AskOption {
  /** The answer, as the person would say it: it is sent as their words ("Approve w1360 and merge #1799"). */
  label: string;
  /** One line on what choosing it means. */
  description: string;
  /** The orchestrator's pick. At most one; it is shown first, marked "Recommended". */
  recommended?: boolean;
}

export interface Ask {
  question: string;
  /** Recommended first; the rest in the order given. */
  options: AskOption[];
}

const oneLine = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/**
 * The tool's input as an Ask, or a reason it is no question. The recommended option moves to the front; two marked
 * recommended is refused (one pick is the point).
 */
export function checkAsk(input: unknown): { ask: Ask } | { problem: string } {
  const o = (input ?? {}) as { question?: unknown; options?: unknown };
  const question = typeof o.question === 'string' ? o.question.trim() : '';
  if (!question) return { problem: 'question: the question, in a sentence' };
  if (question.length > QUESTION_CHARS) return { problem: `question: at most ${QUESTION_CHARS} characters (put the detail in your message above it)` };
  if (!Array.isArray(o.options) || o.options.length < MIN_OPTIONS || o.options.length > MAX_OPTIONS) return { problem: `options: ${MIN_OPTIONS} to ${MAX_OPTIONS} (the page adds "${CHAT_MORE_LABEL}" itself)` };
  const options: AskOption[] = [];
  for (const raw of o.options as { label?: unknown; description?: unknown; recommended?: unknown }[]) {
    const label = oneLine(raw?.label, LABEL_CHARS + 1);
    if (!label) return { problem: 'every option needs a label' };
    if (label.length > LABEL_CHARS) return { problem: `option labels: at most ${LABEL_CHARS} characters ("${label.slice(0, 30)}…")` };
    if (label.toLowerCase() === CHAT_MORE_LABEL.toLowerCase()) return { problem: `"${CHAT_MORE_LABEL}" is added by the page; leave it out` };
    if (options.some((x) => x.label.toLowerCase() === label.toLowerCase())) return { problem: `two options are both "${label}"` };
    options.push({ label, description: oneLine(raw?.description, DESCRIPTION_CHARS), ...(raw?.recommended === true ? { recommended: true } : {}) });
  }
  const picks = options.filter((x) => x.recommended);
  if (picks.length > 1) return { problem: 'mark ONE option recommended: the one you most prefer' };
  if (picks.length === 1) options.unshift(...options.splice(options.indexOf(picks[0]), 1));
  return { ask: { question, options } };
}

/** The question as the quote of an answer shows it: the question, then its options (recommended marked). */
export function askExcerpt(ask: Ask): string {
  return [ask.question, ...ask.options.map((o, i) => `${i + 1}. ${o.label}${o.recommended ? ' (Recommended)' : ''}${o.description ? ` - ${o.description}` : ''}`)].join('\n');
}

/** The question alone, from the excerpt askExcerpt wrote (a reply's quote shows it without the options); undefined for any other text. */
export function questionOf(excerpt: string): string | undefined {
  const m = /^([^\n]+)\n1\. .+\n2\. /.exec(excerpt);
  return m ? m[1] : undefined;
}

/** Which option a person's message chose, if it answers the question at `askSeq`: its index in `ask.options`, else undefined. */
export function chosenIn(ask: Ask, text: string, held = ''): number | undefined {
  // A held-calls note (HELD_MARK) rides after a message's words and is FF Factory's, not theirs.
  const words = splitReply(text, held).words;
  const own = (held ? words.split(held)[0] : words).trim();
  const i = ask.options.findIndex((o) => o.label === own);
  return i < 0 ? undefined : i;
}

/**
 * How the question stands, from the person's messages after it (`later`): answered by a click on option `chosen`, or
 * still open. A message of theirs that quotes the question but is not one of its labels (a typed reply to it) leaves it
 * open: only a click settles it.
 */
export function answerOf(ask: Ask, askSeq: number, later: readonly { text: string }[], held = ''): { chosen: number } | undefined {
  for (const m of later) {
    if (splitReply(m.text, held).quote?.seq !== askSeq) continue;
    const chosen = chosenIn(ask, m.text, held);
    if (chosen !== undefined) return { chosen };
  }
  return undefined;
}
