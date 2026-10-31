import fs from 'node:fs';
import { MAX_MEDIA, splitMedia } from '../shared/ask.ts';
import type { WorkItem } from '../shared/types.ts';
import { mediaLine, mediaNamed, onDisk, previewsOf } from './reviewMedia.ts';

/**
 * A question about visual work carries its previews in the card (w2478; Ben, 2026-10-28, on a card asking him to OK the
 * Circuit Calculation window's operator rows with no stills in it: "i need to see previews. stop asking me questions in the
 * intakes without showing my previews when applicable"; before that w1602, 2026-10-19: "when you ask me about visual things
 * you have to include the previews", and w1797, 2026-10-23).
 *
 * A question is visual when a request it is about has review media: stills or clips in a review topic named for it
 * (`w2186`, `w2186-calc`), in a topic its workers published to under another name (WorkItem.reviewTopics, kept by
 * publish_review), or named in its last [needs you] (WorkNeedsYou.previews). Such a question passes only when it shows at
 * least one still or clip that is there: one of the request's files, or another file in the review folder. Otherwise it is
 * refused with the request's newest files as lines to paste, unless the call says why no previews apply (`no_previews`),
 * which is logged on the request. w1602's "the same call again goes through" is gone: a repeat was how a card went out bare.
 *
 * Every path that puts a question on a person's Waiting on input tab checks it: ask_person (a person's orchestrator),
 * waiting_on_person (a worker) and decide_work ask (the dispatcher).
 */

/** At most this many files a refusal lists per request. */
export const REFUSAL_FILES = 6;
/** A reason for no previews is at least this long: "n/a" is no reason. */
export const NO_PREVIEWS_MIN = 12;
const NO_PREVIEWS_MAX = 300;

type Req = Pick<WorkItem, 'id'> & Partial<Pick<WorkItem, 'reviewTopics' | 'needsYou'>>;

/** A written path as the review file it is, when there is one: a still that is not there shows on no card. */
const reviewFile = (u: string, root: string) => {
  const f = onDisk(u, root);
  return f && fs.statSync(f, { throwIfNoEntry: false })?.isFile() ? f : undefined;
};

/** Each request's review media, newest first (all of it, for matching; the refusal lists the first few). */
export function requestMedia(reqs: readonly Req[], root: string): { id: string; files: string[] }[] {
  const out: { id: string; files: string[] }[] = [];
  for (const w of reqs) {
    const id = w.id.toLowerCase();
    const inTopics = previewsOf([id], { root }, () => w.reviewTopics ?? [], 200)[0]?.files ?? [];
    // The files its last [needs you] named that are still there (a folder named there is expanded by mediaNamed).
    const named = w.needsYou?.previews?.length ? mediaNamed(w.needsYou.previews, { root, ids: [id] }).files.filter((f) => reviewFile(f, root)) : [];
    const files = [...new Set([...inTopics, ...named])];
    if (files.length) out.push({ id, files });
  }
  return out;
}

/** The reason a call gave for no previews, cleaned; undefined when it gave none. */
export function noPreviewsReason(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const r = v.replace(/\s+/g, ' ').trim();
  return r ? r.slice(0, NO_PREVIEWS_MAX) : undefined;
}

/** An answer that is no design of its own ("None of these", "Something else", "Keep it as it is"): it needs no still. */
const NO_DESIGN = /^(none|neither|other|something else|keep|leave|skip|no change|not yet|later|stop|cancel)\b/i;
/** Words of a question that make it a pick between looks, when its request has review media ("Which design…", "A or B"). */
const DESIGN_WORDS = /\b(designs?|mock(?:s|ups?)?|layouts?|variants?|concepts?|which (?:one|look|style|version)|[a-d] or [a-d])\b/i;

export interface PickAsk {
  question: string;
  options: readonly { label: string; description?: string }[];
}

/**
 * A pick between designs shows each design's own still or clip in its own option (w2664; Ben, 2026-10-31: "you didnt show
 * me previews for C and D", and "for all the choices above you didnt show the preview images for the mocks"): a still in
 * the question or in one option does not stand for the others, and no_previews cannot excuse it. A pick is a question
 * where two or more options carry a review still, or, on a request with review media, one whose words say it picks a look
 * (DESIGN_WORDS). An approval ("OK as is" with a still, "Change it" without) is no pick.
 * Returns the refusal's words, or undefined.
 */
export function designPickProblem(asks: readonly PickAsk[], root: string, visual: boolean, tool: string): string | undefined {
  for (const a of asks) {
    const designs = a.options.filter((o) => !NO_DESIGN.test(o.label.trim()));
    if (designs.length < 2) continue;
    const shows = (o: PickAsk['options'][number]) => splitMedia(o.description ?? '').media.some((m) => reviewFile(m.url, root));
    const bare = designs.filter((o) => !shows(o));
    if (!bare.length) continue;
    // Two designs with stills and one without (w2580's C and D), or a question that says it picks a look.
    const some = designs.length - bare.length >= 2;
    if (!some && !(visual && DESIGN_WORDS.test(splitMedia(a.question).text))) continue;
    const where = tool === 'ask_person' ? 'its `description`' : "its answer's `description`";
    return (
      `Not shown: "${clipText(splitMedia(a.question).text)}" picks between designs, and ${bare.map((o) => `"${o.label}"`).join(', ')} ${bare.length === 1 ? 'carries' : 'carry'} no still of its own. ` +
      `Each design shows its own still or clip in ${where} as ![what it shows](<review path>), up to ${MAX_MEDIA} each; a still in the question or in another option does not stand for it ` +
      `(w2664, Ben: "you didnt show me previews for C and D"). no_previews does not excuse a pick between designs. Publish the missing stills with publish_review and call ${tool} again.`
    );
  }
  return undefined;
}

const clipText = (t: string) => (t.length > 120 ? `${t.slice(0, 119)}…` : t);

export type VisualAskVerdict =
  | { ok: true; visual: false }
  | { ok: true; visual: true; shown: string[] }
  | { ok: true; visual: true; optedOut: string; ids: string[] }
  | { ok: false; problem: string; ids: string[] };

/**
 * The check. `texts`: what the card shows (the question and every option's label and description; a worker's `what` too).
 * `asks`: the same questions with their options apart, for the pick-between-designs rule (designPickProblem).
 * `alsoNamed`: whether a bare path or file name in the texts counts as shown (a worker's card lists what its words name; an
 * ask_person card shows only `![..](<path>)`). `tool`: the tool's name, for the refusal's words.
 */
export function visualAskCheck(input: { texts: readonly string[]; asks?: readonly PickAsk[]; reqs: readonly Req[]; root: string; noPreviews?: unknown; tool: string; person: string; alsoNamed?: boolean }): VisualAskVerdict {
  const found = requestMedia(input.reqs, input.root);
  const ids = found.map((f) => f.id);
  const pick = input.asks ? designPickProblem(input.asks, input.root, found.length > 0, input.tool) : undefined;
  if (pick) return { ok: false, ids, problem: pick };
  if (!found.length) return { ok: true, visual: false };
  const inline = input.texts.flatMap((t) => splitMedia(t).media.map((m) => m.url));
  const named = input.alsoNamed ? mediaNamed(input.texts, { root: input.root, ids }).files : [];
  // One of the request's files, or another file in the review folder (an older iteration, a reference): it shows.
  const shown = [...new Set([...inline, ...named])].filter((u) => reviewFile(u, input.root));
  if (shown.length) return { ok: true, visual: true, shown };
  const reason = noPreviewsReason(input.noPreviews);
  if (reason && reason.length >= NO_PREVIEWS_MIN) return { ok: true, visual: true, optedOut: reason, ids };
  const lines = found.map((f) => `${f.id} (newest first):\n${f.files.slice(0, REFUSAL_FILES).map(mediaLine).join('\n')}`).join('\n');
  const broken = inline.length ? ` The ${inline.length === 1 ? 'still in it is' : 'stills in it are'} not in the review folder (${inline.slice(0, 2).join(', ')}), so the card would show nothing.` : '';
  const where = input.tool === 'ask_person' ? '`question` (up to 4) and in the `description` of the option it belongs to (up to 4 each)' : 'the question it shows (up to 4) and the `description` of the answer it belongs to';
  return {
    ok: false,
    ids,
    problem:
      `Not shown: this question is about ${ids.join(', ')}, whose work has review stills or clips, and the card carries none of them.${broken} ` +
      `${input.person} sees only what is IN the card (w2478, Ben: "i need to see previews. stop asking me questions in the intakes without showing my previews when applicable"). ` +
      `Put each still or clip that shows what you ask as ![what it shows](<absolute path>) in ${where}. The newest:\n${lines}\n` +
      `If this question is not about anything visual (a plan, a cost, a merge order), call ${input.tool} again with no_previews: why, in a line ("asks which branch to merge first; nothing to look at"). It is logged on the request.`,
  };
}
