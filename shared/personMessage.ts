// A person's message as their own chat shows it (web/src/components/Transcript.tsx UserMessage), read from the text the
// orchestrator received. Shared so `node --test` checks what the page draws.
import { beforeNote, NOTE_MARKS } from './conditional.ts';
import { splitReply, splitSent, splitVia, type Quoted } from './replies.ts';

/** What the bubble shows: the person's words, the message they replied to, the client it came from, who it was sent to. */
export interface PersonMessageView {
  words: string;
  quote?: Quoted;
  via?: string;
  sentTo?: { userId: string; displayName: string };
}

/**
 * FF Factory's notes after the words (NOTE_MARKS: the w830 held calls, the w1955 open questions and w3253 [for you]
 * messages) are the orchestrator's alone: the person's chat leaves them out (w3297, lothsahn: "hide that note from my chat").
 */
export function personMessageView(text: string): PersonMessageView {
  const v = splitVia(text);
  const sent = splitSent(v.text);
  const { words, quote } = splitReply(sent.text, NOTE_MARKS);
  return { words: beforeNote(words).trim(), quote, via: v.via, sentTo: sent.sentTo };
}
