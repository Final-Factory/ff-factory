/**
 * Messages of a person's own orchestrator that wait for them (w3253, lothsahn: "When you have a message or question from me
 * it often gets lost in a wall of text. Can we update the portal so messages I don't respond to appear in the list of
 * messages, similar to ones from Ben, that we have to clear?"). The orchestrator starts such a message with FOR_YOU_MARK;
 * FF Factory keeps it (SessionInfo.forYou) in the bubble over the person's message box, beside other people's messages,
 * until the person replies to it, the orchestrator closes it (close_question) after their answer, or they clear it.
 */
export const FOR_YOU_MARK = '[for you]';

/** At most this many wait in one chat: the oldest go first. */
export const FOR_YOU_KEPT = 12;

/** A message's words kept in the bubble, at most. */
export const FOR_YOU_CHARS = 2000;

const LEAD = /^\s*\[for you\][ \t]*:?[ \t]*\n?/i;

/** An orchestrator's message without its leading mark, and whether it had one. */
export function splitForYou(text: string): { forYou: boolean; text: string } {
  const m = LEAD.exec(text);
  return m ? { forYou: true, text: text.slice(m[0].length).trimStart() } : { forYou: false, text };
}

/** The id of the mark on the orchestrator's message with this seq. */
export const forYouId = (seq: number) => `fy-${seq}`;
