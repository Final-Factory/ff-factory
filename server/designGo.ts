// The go to build a finished design, asked on a card (w4739, r290 fix 5). lothsahn: "File all six fixes from r290 at high
// now"; r290 measured 9 d 1 h between the finished multi-select design (r87, w3031) and the go to build it, because the go
// was offered in chat ("say 'file the w3031 implementation'") instead of on a card. When a request whose result is a design
// closes on its DONE (Orchestrators.closeOnDone, designClosed), its people's orchestrators get this message. No imports
// from the server, so `node --test` loads it alone.
import type { WorkItem } from '../shared/types.ts';

/** The words a person reads for the design: its request's title without a leading "Design:" or "Design request:". */
export function designName(w: Pick<WorkItem, 'title'>): string {
  const t = w.title.replace(/^\s*(?:design(?: request)?|spec)\s*[:-]\s*/i, '').trim() || w.title.trim();
  return t.length > 120 ? `${t.slice(0, 119)}…` : t;
}

/** The question on the go card. */
export function designGoQuestion(w: Pick<WorkItem, 'title'>): string {
  return `File the build of ${designName(w)} now?`;
}

type DesignLink = NonNullable<WorkItem['reports']>[number];

/**
 * The message to a design's people's orchestrators when its request closed: ask the go on an ask_person card with "file
 * the build now" recommended; or, when the report still lists open questions, ask those first, every one, before the go.
 * A design whose report has no "Open questions" section (openQuestionsOf: undefined) is read first.
 */
export function designGoAsk(w: Pick<WorkItem, 'id' | 'title' | 'requesters'>, designs: readonly DesignLink[]): string {
  const who = w.requesters.map((r) => r.displayName).join(' and ') || 'its person';
  const ids = designs.map((d) => `${d.id} "${d.title}"`).join(', ');
  const open = designs.flatMap((d) => d.openQuestions ?? []);
  const unread = designs.filter((d) => d.openQuestions === undefined);
  const question = designGoQuestion(w);
  const head = `[design closed] ${w.id} "${w.title}" closed, and its result is a design (${ids}).`;
  const why = `Never offer the go in chat ("say 'file the build'"): r290 measured 9 days between the finished multi-select design (r87) and its go, offered in chat with no card (w4739).`;
  const go =
    `ask_person, request ${w.id}: "${question}", options "Yes, file the build now" (recommended), "Not yet, I'll say when", and "Change the design first". ` +
    `If ${w.id} has review stills, put the design's main one in the question; else no_previews ("a go to build; the design is decided"). ` +
    `On yes, file the build with request_work (related_ids ["${w.id}"], the design report's id in the brief, its stages as the design splits them) and say what you filed. On "not yet", note it on ${w.id} and ask nothing more.`;
  if (open.length) {
    const list = open.slice(0, 6).map((q, i) => `${i + 1}. ${q}`).join('\n');
    return (
      `${head} Its report still lists ${open.length} open question${open.length === 1 ? '' : 's'}:\n${list}${open.length > 6 ? `\n(and ${open.length - 6} more in the report)` : ''}\n` +
      `Ask ${who} these now, before the go: each as one ask_person question (request ${w.id}, the design's own pick recommended), all of them in a row, starting with the first this turn; read the report (read_report) for their options. ` +
      `Record each answer on ${w.id} (update_work note). Once all are answered, ask the go the same way: ${go} ${why}`
    );
  }
  if (unread.length) {
    return `${head} ${unread.map((d) => d.id).join(', ')} has no "Open questions" section: read it (read_report). If it leaves questions open, ask ${who} each as one ask_person question (request ${w.id}, the design's pick recommended), all of them in a row, then the go; if none, ask the go now: ${go} ${why}`;
  }
  return `${head} Its report leaves no open questions. Ask ${who} the go now: ${go} ${why}`;
}
