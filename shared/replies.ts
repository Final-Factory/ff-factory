// Replies and emoji reactions in a person's orchestrator chat (w866; docs/orchestrators.md, "Replies and reactions").
// Both reach the orchestrator as text that quotes the message they are on, so the quote survives the send queue, a restart's
// resume and the transcript. The page reads the same text back (splitReply, parseReaction) to draw the quote and the
// reaction chips. No imports, so the browser bundle and `node --test` can both load it.

/**
 * Where FF Factory's quote starts in a person's reply: what follows is the quoted message (data), never the person's words.
 * Like HELD_MARK (shared/conditional.ts), `inPersonWords` stops at it, so a conditional decision's "words" cannot be found
 * in a quote.
 */
export const REPLY_MARK = '[FF Factory, not your person: the message they are replying to]';

/** The longest excerpt of the quoted message a reply or a reaction carries, in characters. */
export const EXCERPT_CHARS = 1200;

/** A message of the chat, as a reply or a reaction quotes it. */
export interface Quoted {
  /** Its transcript sequence number. */
  seq: number;
  /** Who said it: "the orchestrator", a person's name, or "a [worker update]" for a relayed line. */
  from: string;
  /** When, ISO. */
  at: string;
  /** Its text, clipped to EXCERPT_CHARS. */
  excerpt: string;
}

/** Emoji the page offers on a message; the server takes any single emoji. */
export const REACTION_PALETTE = ['👍', '👎', '✅', '❌', '❓', '👀', '🎉'] as const;

/** One line for what the common emoji mean, for the orchestrator and for docs. Anything else it reads from context. */
export const REACTION_MEANINGS = '👍 or ✅ = yes, go ahead, got it; 👎 or ❌ = no, don\'t; ❓ = I don\'t follow, explain; 👀 = seen, I\'ll look; 🎉 or ❤️ = nice, nothing to do';

const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** The excerpt of a message's text: its own words only (an earlier quote or FF Factory note in it is left out), clipped. */
export function excerptOf(text: string, held = ''): string {
  let own = text.split(REPLY_MARK)[0];
  if (held) own = own.split(held)[0];
  own = own.trim();
  return own.length > EXCERPT_CHARS ? `${own.slice(0, EXCERPT_CHARS).trimEnd()}… (${own.length - EXCERPT_CHARS} more characters)` : own;
}

/** `#42 · the orchestrator · 2026-10-10 08:31 UTC` and the excerpt, each line quoted with "> ". */
export function quoteBlock(q: Quoted): string {
  const lines = (q.excerpt || '(no text)').split('\n').map((l) => `> ${l}`);
  return `#${q.seq} · ${q.from} · ${utc(q.at)}\n${lines.join('\n')}`;
}

/** A person's reply: their words, then FF Factory's mark and the quoted message. */
export function replyText(words: string, q: Quoted): string {
  return `${words.trim()}${words.trim() ? '\n\n' : ''}${REPLY_MARK}\n${quoteBlock(q)}`;
}

const QUOTE_HEAD = /^#(\d+) · (.+) · (\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC$/;

/** Read a quote block back: the lines up to `until` (the next note of FF Factory's) or the end. */
function readQuote(block: string): Quoted | undefined {
  const lines = block.split('\n');
  const m = QUOTE_HEAD.exec(lines[0] ?? '');
  if (!m) return undefined;
  const excerpt = lines
    .slice(1)
    .filter((l) => l.startsWith('> ') || l === '>')
    .map((l) => l.slice(2))
    .join('\n');
  return { seq: Number(m[1]), from: m[2], at: `${m[3]}T${m[4]}:00.000Z`, excerpt: excerpt === '(no text)' ? '' : excerpt };
}

/**
 * A message's text apart from the reply quote it carries: the person's own words, and the quoted message when there is one.
 * `held` is where a later note of FF Factory's starts (HELD_MARK), which ends the quote.
 */
export function splitReply(text: string, held = ''): { words: string; quote?: Quoted } {
  const at = text.indexOf(REPLY_MARK);
  if (at < 0) return { words: text };
  const after = text.slice(at + REPLY_MARK.length).replace(/^\n/, '');
  const end = held ? after.indexOf(held) : -1;
  const block = (end < 0 ? after : after.slice(0, end)).replace(/\s+$/, '');
  const rest = end < 0 ? '' : after.slice(end);
  return { words: text.slice(0, at).trim() + (rest ? `\n\n${rest}` : ''), quote: readQuote(block) };
}

/** Whether `s` is one emoji (a pictograph with its modifiers, a flag, a keycap or a joined family), nothing else. */
export function isEmoji(s: string): boolean {
  if (!s || s.length > 32 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(s)) return false;
  const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
  return [...seg.segment(s)].length === 1;
}

/**
 * What the orchestrator reads when its person reacts to a message: the emoji, the message it is on, and how to take it.
 * Sent as a harness message (`from: 'system'`): the click opens no turn of the person's. `armed` (w1039): the click answers
 * the orchestrator's own recent message with 👍 ✅ 👎 ❌, so FF Factory takes it as the person's own words for the action
 * that message proposes, for the gates that need them (Orchestrators.reactionTurn).
 */
export function reactionText(person: string, emoji: string, q: Quoted, armed = false): string {
  const head = `[reaction] ${person} reacted ${emoji} to a message in this chat:
${quoteBlock(q)}

Take it as ${person}'s short answer to that message: ${REACTION_MEANINGS}; any other emoji, by its usual meaning in that context.`;
  if (!armed) {
    return `${head} It is a click, not ${person}'s own words, so what needs their own words (approving or declining a request, deleting, settings, deploys, a release) still needs them to say it: ask in one line. Reply briefly, or just act on it.`;
  }
  const yes = emoji === '👍' || emoji === '✅';
  return `${head} This is your own message and ${person} answered it with ${yes ? 'a yes' : 'a no'}. FF Factory counts that click as ${person}'s OWN WORDS for the action that message proposes, and for nothing else in this turn: ${
    yes
      ? "the request and the action its sentence names together (approve, decline, close, a `when` decision, main_clone, a portal deploy or restart, a delegation approval) go through now with the usual tool call, and the decision's record shows the click and the sentence it answered (leave `words` out of a `when` call; FF Factory fills it in). Anything the message did not propose, or proposed unclearly, or proposed several of: do only what is clear and ask in one line about the rest."
      : "do not do what the message proposed. The one thing a no covers is declining an intake request whose approval the message proposed (update_work decline); otherwise take it as a no and say so in a line."
  } What the click cannot do, it is refused as before.`;
}

/** The record that a reaction was taken back; it is shown in the chat and not sent to the orchestrator. */
export function reactionRemovedText(emoji: string, seq: number): string {
  return `[reaction removed] ${emoji} #${seq}`;
}

export interface ReactionMark {
  /** The message it is on (a transcript seq). */
  to: number;
  emoji: string;
  on: boolean;
}

const REACTION_ON = /^\[reaction\] .+? reacted (\S+) to a message in this chat:\n#(\d+) · /u;
const REACTION_OFF = /^\[reaction removed\] (\S+) #(\d+)$/u;

/** A reaction put on a message, or taken off one, as the transcript records it; undefined for any other text. */
export function parseReaction(text: string): ReactionMark | undefined {
  const on = REACTION_ON.exec(text);
  if (on) return { to: Number(on[2]), emoji: on[1], on: true };
  const off = REACTION_OFF.exec(text);
  return off ? { to: Number(off[2]), emoji: off[1], on: false } : undefined;
}

/** The reactions on each message after replaying the chat in order: seq → emoji → count (one person's chat: 1 or 0). */
export function reactionsByMessage(texts: Iterable<{ text: string }>): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const { text } of texts) {
    const r = parseReaction(text);
    if (!r) continue;
    const have = out.get(r.to) ?? [];
    const next = r.on ? (have.includes(r.emoji) ? have : [...have, r.emoji]) : have.filter((e) => e !== r.emoji);
    if (next.length) out.set(r.to, next);
    else out.delete(r.to);
  }
  return out;
}

// ---------------------------------------------------------------- messages from an MCP client (w1021)

/**
 * A message a person sent their own orchestrator from Claude Code or Claude Desktop starts with this line (server/remoteChat.ts):
 * the orchestrator reads where it came from, and the page shows it as a small tag instead of a line of text.
 */
export const VIA_LINE = /^\[via ([^\]\n]{1,120})\]\n/;

/** The client label of a message sent from outside the page, and the person's words without the label line. */
export function splitVia(text: string): { via?: string; text: string } {
  const m = VIA_LINE.exec(text);
  return m ? { via: m[1], text: text.slice(m[0].length) } : { text };
}

// ---------------------------------------------------------------- a reply sent straight to another person (w1831)

/** The longest message one person sends another (message_person, and a reply from the bubble). */
export const PERSON_MESSAGE_CHARS = 2000;

/**
 * Where FF Factory's note starts on a person's reply to another person's message, sent from the bubble over their message
 * box (w1831): the words before it already reached that person as message_person sends them, with no turn of the
 * orchestrator in between. The page shows it as a "Sent to <name>" tag; `inPersonWords` stops at it, as at HELD_MARK.
 */
export const SENT_MARK = '[FF Factory, not your person: already sent]';

const SENT_LINE = /\n*\[FF Factory, not your person: already sent\] To (.+?) \(user id ([^)\s]+)\):[^\n]*/;

/**
 * What a person's own orchestrator reads when its person answered another person straight from the bubble: their words,
 * the message they answered quoted (when the chat has it), and FF Factory's note that the words are delivered.
 */
export function sentText(words: string, to: { userId: string; displayName: string }, q?: Quoted): string {
  const note = `${SENT_MARK} To ${to.displayName} (user id ${to.userId}): FF Factory delivered the words above as message_person does, from the Reply box on ${to.displayName}'s message, with no turn of yours. They are sent: never send them again. Take them as context, and answer in a line at most.`;
  return `${q ? replyText(words, q) : words.trim()}\n\n${note}`;
}

/** A message's text without FF Factory's "already sent" note, and who it was sent to when it has one. */
export function splitSent(text: string): { text: string; sentTo?: { userId: string; displayName: string } } {
  const m = SENT_LINE.exec(text);
  return m ? { text: text.slice(0, m.index) + text.slice(m.index + m[0].length), sentTo: { displayName: m[1], userId: m[2] } } : { text };
}

// ---------------------------------------------------------------- the message a person's message answers (w2758)

/**
 * A message of the recipient's own that another person's message answers (w2758, lothsahn: "When replying to an operator,
 * the operator should see the message replied to as well as the reply"). It rides the [person message] text after the
 * sender's words, so the recipient's chat and their orchestrator read the same quote.
 */
export interface Answered {
  /** When the recipient sent it, ISO. */
  at: string;
  /** Its words, clipped to ANSWER_EXCERPT_CHARS. */
  excerpt: string;
  /** False when FF Factory guessed it (the sender named none and several were open): "maybe in answer to". */
  sure: boolean;
}

/** The longest excerpt of one answered message a [person message] carries. Several can ride one message. */
export const ANSWER_EXCERPT_CHARS = 600;

/** The most answered messages one [person message] quotes. */
export const ANSWERS_MAX = 3;

const ANSWER_HEAD = /^\[FF Factory, not the sender's words: (maybe )?in answer to (.+?)'s message of (\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC[^\]\n]*\]$/;

/** The words of a person's message without the answered messages it quotes, clipped for a quote of its own. */
export function answerExcerpt(text: string): string {
  const own = splitAnswered(text).words;
  return own.length > ANSWER_EXCERPT_CHARS ? `${own.slice(0, ANSWER_EXCERPT_CHARS).trimEnd()}… (${own.length - ANSWER_EXCERPT_CHARS} more characters)` : own;
}

/**
 * The sender's words, then one block per message of the recipient's they answer:
 * `[FF Factory, not the sender's words: in answer to Lothsahn's message of 2026-10-31 08:00 UTC]` and its words, "> " quoted.
 */
export function answeredText(words: string, recipient: string, answers: readonly Answered[]): string {
  const blocks = answers.map((a) => {
    const head = `[FF Factory, not the sender's words: ${a.sure ? '' : 'maybe '}in answer to ${recipient}'s message of ${utc(a.at)}${a.sure ? '' : ' (the sender did not say which)'}]`;
    return `${head}\n${(a.excerpt || '(no text)').split('\n').map((l) => `> ${l}`).join('\n')}`;
  });
  return [words.trim(), ...blocks].join('\n\n');
}

/** Read answeredText back: the sender's own words, and the messages they answer. Text without a quote is all words. */
export function splitAnswered(text: string): { words: string; answers: Answered[] } {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => ANSWER_HEAD.test(l));
  if (first < 0) return { words: text.trim(), answers: [] };
  const answers: Answered[] = [];
  for (let i = first; i < lines.length; i++) {
    const m = ANSWER_HEAD.exec(lines[i]);
    if (!m) continue;
    const quoted: string[] = [];
    for (let j = i + 1; j < lines.length && (lines[j].startsWith('> ') || lines[j] === '>'); j++) quoted.push(lines[j].slice(2));
    const excerpt = quoted.join('\n');
    answers.push({ at: `${m[3]}T${m[4]}:00.000Z`, excerpt: excerpt === '(no text)' ? '' : excerpt, sure: !m[1] });
  }
  return { words: lines.slice(0, first).join('\n').trim(), answers };
}
