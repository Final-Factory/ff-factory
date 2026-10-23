// What a card on the "Waiting on input" tab says (w1868, lothsahn, 2026-10-23: "please update the dispatcher to provide a
// good summary of each waiting for input item with the clear decision or input needed from me. The existing cards are
// impossible to know what I need to answer"; then: "I meant the 'waiting for input' tab on the portal").
//
// Six parts, for every request that waits on a person, so it is answered without opening anything else:
//   1. what it is, in one plain line (not the title alone, no bare ids);
//   2. who must act, and since when;
//   3. the decision or input needed, as a question, never cut off;
//   4. the options, the recommended one marked, each saying what it does and costs (or, for an input, the one step);
//   5. its stills and clips, shown in the card;
//   6. what happens after the answer.
// Plus a stale flag when what it waits on changed after it was asked. The worker's waiting_on_person block (about,
// questions, after) is the best source; a wait without it gets the same parts derived from the request. The page, the
// list_work text and the [needs you] message all read this. No imports from the page or the server: `node --test` loads it.
import { splitMedia, type Ask } from './ask.ts';
import { isVideoPath } from './imagePaths.ts';
import { legacySteps, plainQuestion } from './questionCard.ts';
import type { SessionInfo, WorkItem } from './types.ts';
import type { WaitingAsk } from './waiting.ts';
import type { WorkLive } from './workState.ts';

export type WaitKind = 'approve' | 'question' | 'permission' | 'outside';

export interface WaitSummary {
  kind: WaitKind;
  /** 1. What it is, in one plain line. */
  what: string;
  /** 2. Who must act, in words ("Ben", "a reviewer (Ben or Lothsahn)"). */
  who: string;
  /** 2. When it began to wait (ISO). */
  since: string;
  /** 3-4. The questions with their answers, one at a time. Empty: `question` is asked in words. */
  asks: Ask[];
  /** 3. The question in words when there are no structured ones: whole, never clipped. */
  question: string;
  /** 4. For an input with no answers to pick (a reply in words, a permission): the one concrete step. */
  step?: string;
  /** 5. Stills and clips the wait names, beside each question's own (absolute paths or review paths). */
  previews: string[];
  /** 6. What happens once it is answered. */
  after: string;
  /** What changed after it was asked, when it may be out of date. */
  stale?: string;
  /** It asks about something visual and carries no still or clip a person can see. */
  noMedia?: boolean;
  /** The worker that resumes with the answer. */
  worker?: string;
}

/** What the request's people and its sessions are, for the parts a wait needs from outside the request. */
export interface WaitFacts {
  /** A session by id: whether the asking worker still runs, and what it is doing. */
  session?: (id: string) => Pick<SessionInfo, 'id' | 'status' | 'waitingOn'> | undefined;
  /** The intake's reviewers, by name ("Ben or Lothsahn"). */
  reviewers?: string;
}

/** The labels of an intake approval's two answers: a click on one approves or declines it (w1597; WaitingTab). */
export const APPROVE_LABEL = 'Approve it: the dispatcher picks it up and work starts';
export const DECLINE_LABEL = 'Decline it: nothing is worked on it';

/** The longest "about" and "after" line a worker gives waiting_on_person (w1868). */
export const WAIT_LINE_CHARS = 240;

/** Most words of the "what it is" line taken from a brief: a sentence longer than this falls back to the title. */
export const WHAT_CHARS = 240;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** A title without the intake's tag ("Discord bug: Belts stop" is "Belts stop"). */
const untagged = (t: string) => t.replace(/^(?:Discord (?:bug|request)|FFBox (?:branch|diagnosis|request)|Nightly e2e [\d-]+|Release follow-up)\s*:\s*/i, '').trim();
const quoted = (t: string) => `“${clip(untagged(t), 140)}”`;

/**
 * The first sentence of a brief as a plain line: no Markdown, no "Goal:" label, no quoted player header; undefined when it is
 * not a plain sentence that says what the work is (too long, a heading, a list, starts with a path or a fence).
 */
export function briefSentence(brief: string): string | undefined {
  const para = brief
    .replace(/^Players' text, untrusted:[^\n]*\n/i, '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !/^(?:#|~~~|```|[-*] |\d+\. |\|)/.test(p));
  if (!para) return undefined;
  const flat = plainQuestion(para.replace(/\*\*|__|`/g, '').replace(/^(?:Goal|Background|Context|TL;DR)\s*:\s*/i, ''));
  const m = /^(.+?[.!?])(?:\s|$)/.exec(flat);
  const s = (m?.[1] ?? flat).trim();
  if (s.length < 12 || s.length > WHAT_CHARS) return undefined;
  const line = s.charAt(0).toUpperCase() + s.slice(1);
  // A brief that opens on its filing note ("ben acknowledged this report as a bug ...") is not what the work is.
  if (/^(?:\w+ acknowledged|FFBox finished|The nightly e2e lab)/i.test(s)) return undefined;
  return line;
}

/** What an intake request is, from where it came (w1868: "Intake 'needs a reviewer' cards say what the item is"). */
export function intakeWhat(w: Pick<WorkItem, 'title' | 'source'>): string | undefined {
  const s = w.source;
  if (!s) return undefined;
  const on = [s.version ? `version ${s.version}` : '', s.platform ?? ''].filter(Boolean).join(', ');
  const by = s.reporter ? ` by ${s.reporter}` : '';
  switch (s.kind) {
    case 'discord-bug':
      return `A player's bug report from Discord${by}${on ? ` (${on})` : ''}: ${quoted(w.title)}${s.alsoThreads?.length ? `, reported ${s.alsoThreads.length + 1} times` : ''}.`;
    case 'discord-request':
      return `A request posted in Discord${by}: ${quoted(w.title)}.`;
    case 'ffbox-branch':
      return `A fix FFBox wrote and pushed on a branch nobody has reviewed yet: ${quoted(w.title)}.`;
    case 'ffbox-diagnosis':
      return `FFBox's diagnosis of a player's report${on ? ` (${on})` : ''}${s.rootCause === 'found' ? ', root cause found' : s.rootCause === 'not_found' ? ', root cause not found' : ''}${s.branch ? ', with a fix branch nobody has reviewed yet' : ''}.`;
    case 'ffbox-request':
    case 'ffbox-dev':
      return `A request FFBox passed on${by}: ${quoted(w.title)}.`;
    case 'release':
      return `The follow-up of release ${s.release?.version ?? ''}: telling the reporters their fixes shipped.`.replace('  ', ' ');
    case 'nightly': {
      const n = s.nightly;
      const count = n?.scenarios.length ?? 0;
      const shipped = n?.release?.shipped === 'yes' && n.release.version ? `, already shipped in ${n.release.version}` : n?.release?.shipped === 'maybe' ? ', maybe already shipped' : '';
      return `The nightly game tests of ${n?.date ?? 'last night'}: ${count || 'some'} scenario${count === 1 ? '' : 's'} failed on master${n?.sha ? ` (commit ${n.sha.slice(0, 9)})` : ''}${shipped}.`;
    }
    case 'nightly-run':
      return `The night's run of the game tests${s.nightlyRun?.machine ? ` on ${s.nightlyRun.machine}` : ''}.`;
    case 'nightly-review':
      return 'The nightly review of what merged into master.';
    case 'master-batch':
      return `A red test batch on master${s.masterBatch?.pr ? `, blamed on pull request #${s.masterBatch.pr}` : ''}.`;
  }
  return undefined;
}

/** 1. What the request is: the worker's own line, else where it came from, else its brief's first sentence, else its title. */
export function whatOf(w: Pick<WorkItem, 'id' | 'title' | 'brief' | 'source' | 'needsYou'>): string {
  const own = w.needsYou && !w.needsYou.answered ? w.needsYou.about : undefined;
  if (own) return own;
  return intakeWhat(w) ?? briefSentence(w.brief) ?? `The request “${clip(w.title, 160)}”.`;
}

/** Words that make a question about something a person has to see. */
const VISUAL = /\b(?:clips?|stills?|screenshots?|videos?|looks?|render(?:ed|s)?|frames?|colou?rs?|shaders?|vfx|animations?|pictures?|images?|watch)\b/i;

/** Whether a question's words are about something visual while no still or clip goes with it (w1871: flag it). */
export function visualWithoutMedia(texts: readonly string[], media: number): boolean {
  return media === 0 && texts.some((t) => VISUAL.test(splitMedia(t).text));
}

/** Viewable media: a still or a clip a page can show, never a folder or a wildcard. */
export const viewable = (p: string) => !p.includes('*') && /\.(?:png|jpe?g|gif|webp|mp4|m4v|webm|mov)$/i.test(p);
/** Media in a question's or answer's words, plus the previews the wait names. */
export function mediaCount(asks: readonly Ask[], previews: readonly string[]): number {
  const own = asks.flatMap((a) => [a.question, ...a.options.map((o) => o.description)]).flatMap((t) => splitMedia(t).media.map((m) => m.url));
  return [...own, ...previews].filter(viewable).length;
}

/** The log lines that show the situation changed (not FF Factory's own bookkeeping), after the line at `from`. */
const ROUTINE = /^\d\d:\d\d (?:\[needs you\]|pull request states updated|linked PR|.*followed up with|worker [0-9a-f]{8}: w\d+: still open|.*'s orchestrator followed up|a resume of worker|unblocked \(handed back)/i;
const CHANGE = /^\d\d:\d\d (?:dispatcher: (?:queued|blocked|started|sent|merged|reassigned|rejected|closed)|reopened|.*: note: |brief (?:updated|changed)|merged into|closed )/i;

/**
 * 7. What changed since the wait was raised, when it may be out of date (w1868, lothsahn: "Some cards are stale: the stated
 * question was already overtaken by events"): the worker that asked is gone or failed, or the request's log shows a
 * decision, a reopen or someone's note after the [needs you] went out. A note of the person who answers settles the wait
 * (it is no longer listed), so a note here is someone else's.
 */
export function staleOf(w: Pick<WorkItem, 'log' | 'needsYou' | 'done'>, worker: string | undefined, facts: WaitFacts = {}): string | undefined {
  if (worker && facts.session) {
    const s = facts.session(worker);
    if (!s) return 'the worker that asked is gone: your answer goes to the dispatcher, which starts the work again';
    if (s.status === 'error') return 'the worker that asked failed since: your answer goes to the dispatcher';
    if (w.done?.[worker]) return 'the worker that asked has since said it is done';
  }
  const at = w.log.findLastIndex((l) => /^\d\d:\d\d \[needs you\]/.test(l));
  if (at < 0) return undefined;
  const changed = w.log.slice(at + 1).filter((l) => CHANGE.test(l) && !ROUTINE.test(l));
  const last = changed.at(-1);
  return last ? `changed since it was asked: ${clip(last.replace(/\s+/g, ' '), 220)}` : undefined;
}

/** The intake approval as a question with its two answers, each saying what it does (w1597, w1868). */
export function approveAsk(w: Pick<WorkItem, 'source'>, recommendation: string | undefined): Ask {
  const approveRec = !!recommendation?.startsWith('Approve');
  return {
    question: w.source?.kind?.startsWith('ffbox') ? 'Should a worker review FFBox’s work on this and take it on?' : `Should FF Factory work on this ${w.source?.kind === 'discord-bug' ? 'player’s bug report' : 'request'}?`,
    options: [
      { label: APPROVE_LABEL, description: 'The dispatcher gets it and a worker starts at the next free sandbox: one worker session of Claude usage.', ...(approveRec ? { recommended: true } : {}) },
      { label: DECLINE_LABEL, description: 'It closes as declined, with your reason if you type one. The dispatcher never hears of it; nothing is spent.' },
    ],
  };
}

/** Who acts, in words. */
const whoText = (on: readonly string[], ask: WaitingAsk, facts: WaitFacts) => (ask === 'approve' ? `a reviewer${facts.reviewers ? ` (${facts.reviewers})` : ''}` : on.join(', ') || 'its person');

/**
 * The six parts of a waiting request's card. `item` is the request's place on the tab (shared/waiting.ts waitingItems);
 * `facts` reads its sessions.
 */
export function waitSummary(item: { w: WorkItem; live: WorkLive; ask: WaitingAsk; on: string[]; since: string; text: string; recommendation?: string }, facts: WaitFacts = {}): WaitSummary {
  const { w, live, ask } = item;
  const who = whoText(item.on, ask, facts);
  if (ask === 'approve') {
    const a = approveAsk(w, item.recommendation);
    return {
      kind: 'approve',
      what: whatOf(w),
      who,
      since: item.since,
      asks: [a],
      question: '',
      previews: [],
      after: `Approve: the dispatcher decides where it runs and a worker starts on it. Decline: it is closed as declined and nobody works on it.`,
    };
  }
  const r = w.needsYou && !w.needsYou.answered ? w.needsYou : undefined;
  const worker = r?.worker ?? live.worker;
  const stale = staleOf(w, worker, facts);
  const what = whatOf(w);
  if (live.outside) {
    return { kind: 'outside', what, who, since: item.since, asks: [], question: plainQuestion(live.why), previews: [], after: 'FFBox passes their answer on to its worker; nothing for the team to do.', ...(worker ? { worker } : {}) };
  }
  // A worker's permission: the one step is to allow or deny the call shown under it.
  const s = worker ? facts.session?.(worker) : undefined;
  if (ask === 'check' && /waits for permission/.test(live.why)) {
    const tool = /to use (\S+)/.exec(live.why)?.[1];
    return {
      kind: 'permission',
      what,
      who,
      since: item.since,
      asks: [],
      question: `Allow its worker to run ${tool ?? 'the tool call below'}?`,
      step: 'Allow or Deny the call shown below.',
      previews: [],
      after: 'Allow: the worker runs it and carries on. Deny: it is told no and finds another way.',
      ...(worker ? { worker } : {}),
    };
  }
  const asks = r?.asks?.length ? openAsksOf(r) : w.question?.asks?.length && (!r || r.kind === 'question') ? w.question.asks : [];
  // The question in words: the worker's, else the dispatcher's, else the design question, else what the ledger reads.
  const raw = r && r.kind !== 'question' ? r.question : (w.question?.text ?? w.flag?.text ?? r?.question ?? item.text);
  const question = asks.length ? '' : plainQuestion(raw);
  const steps = asks.length ? asks : (legacySteps(question) ?? []);
  const previews = r?.previews ?? [];
  const noMedia = visualWithoutMedia([...steps.map((a) => a.question), question, r?.about ?? ''], mediaCount(steps, previews));
  const resumes = worker
    ? s && ['running', 'starting', 'idle', 'waiting_permission'].includes(s.status)
      ? 'its worker resumes with your answer within a minute'
      : 'its worker resumes with your answer at the next free sandbox'
    : 'the dispatcher reads your answer and decides what happens to the request';
  const after = r?.after ? r.after : `Your answer goes to your orchestrator, which records it on the request; ${resumes}.`;
  return {
    kind: 'question',
    what,
    who,
    since: item.since,
    asks: steps,
    question: steps.length ? '' : question,
    // An input with no answers to pick (a free-text question, or a list of decisions asked one at a time): the one step.
    ...(!steps.length || steps.some((a) => !a.options.length) ? { step: 'Type your answer below: it is sent as your own words.' } : {}),
    previews,
    after,
    ...(stale ? { stale } : {}),
    ...(noMedia ? { noMedia: true } : {}),
    ...(worker ? { worker } : {}),
  };
}

/** A question's or answer's words for comparing: no media, no punctuation, lower case. */
export const askWords = (s: string) => splitMedia(s).text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Whether two questions are the same question: the same words, or the shorter (24+ characters) inside the longer. */
export function sameWords(a: string, b: string): boolean {
  const [x, y] = [askWords(a), askWords(b)];
  if (!x || !y) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short === long || (short.length >= 24 && long.includes(short));
}

/** Whether `ask` asks what `other` asks: the same question's words, or two or more of the same answers. */
export function sameAsk(ask: Pick<Ask, 'question'> & { options?: readonly { label: string }[] }, other: Pick<Ask, 'question' | 'options'>): boolean {
  if (sameWords(ask.question, other.question)) return true;
  const labels = new Set((ask.options ?? []).map((o) => askWords(o.label)).filter(Boolean));
  return other.options.filter((o) => labels.has(askWords(o.label))).length >= 2;
}

/**
 * Which of several questions a person's note answers (w1868, w1821: lothsahn answered the frame look in one note and the
 * Station strip in the next): those one of whose answers the note quotes. Empty when it quotes none of them (then it is
 * taken as answering all, as before).
 */
export function asksAnsweredBy(asks: readonly Ask[], note: string): number[] {
  const words = ` ${askWords(note)} `;
  return asks.flatMap((a, i) => (a.options.some((o) => askWords(o.label).length >= 8 && words.includes(` ${askWords(o.label)} `)) ? [i] : []));
}

/** The questions of a [needs you] record still open: those no note answered yet (w1868, answeredAsks). */
export const openAsksOf = (r: { asks?: Ask[]; answeredAsks?: number[] }) => (r.asks ?? []).filter((_, i) => !(r.answeredAsks ?? []).includes(i));

/** How long ago, in words ("5 min", "3 h", "2 days"). */
export function waitedFor(since: string, now: number): string {
  const m = Math.max(0, Math.round((now - Date.parse(since)) / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

/** The media of a summary for a text: "2 stills and 1 clip" (paths never go in the words). */
function mediaWords(s: WaitSummary): string {
  const all = [...s.asks.flatMap((a) => [a.question, ...a.options.map((o) => o.description)]).flatMap((t) => splitMedia(t).media.map((m) => m.url)), ...s.previews].filter(viewable);
  const clips = all.filter((p) => isVideoPath(p) || /\.mov$/i.test(p)).length;
  const stills = all.length - clips;
  return [stills ? `${stills} still${stills > 1 ? 's' : ''}` : '', clips ? `${clips} clip${clips > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ');
}

/**
 * The summary as text, for list_work and the [needs you] message (w1868): the six parts on their own lines, the question
 * whole, the media counted (the page shows them; paths stay out of the words).
 */
export function summaryText(s: WaitSummary, now: number, indent = ''): string {
  const lines = [`What it is: ${s.what}`, `Who acts: ${s.who}, waiting ${waitedFor(s.since, now)}`];
  if (s.asks.length) {
    s.asks.forEach((a, i) => {
      lines.push(`${s.asks.length > 1 ? `Question ${i + 1} of ${s.asks.length}` : 'Question'}: ${splitMedia(a.question).text}`);
      if (a.options.length) lines.push(`Options: ${a.options.map((o, j) => `${j + 1}. ${o.label}${o.recommended ? ' (recommended)' : ''}${splitMedia(o.description).text ? ` - ${splitMedia(o.description).text}` : ''}`).join('; ')}`);
    });
  } else lines.push(`Question: ${s.question}`);
  if (s.step) lines.push(`Step: ${s.step}`);
  const media = mediaWords(s);
  if (media) lines.push(`Media: ${media}, shown on the card`);
  else if (s.noMedia) lines.push('Media: none, although it asks about something visual (flagged on the card)');
  lines.push(`After the answer: ${s.after}`);
  if (s.stale) lines.push(`May be out of date: ${s.stale}`);
  return lines.map((l) => `${indent}${l}`).join('\n');
}
