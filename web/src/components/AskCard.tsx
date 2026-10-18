import { useContext, useEffect, useState } from 'react';
import { answerOf, CHAT_MORE_LABEL, mediaMarkdown, splitMedia, type Ask } from '../../../shared/ask';
import { HELD_MARK } from '../../../shared/conditional';
import { api } from '../api';
import { holdReload } from '../freshness';
import { attempt, startReply, useStore } from '../store';
import { Markdown } from './Markdown';
import { ChatActionsContext } from './MessageActions';
import { Icon } from './ui';

/**
 * A question the orchestrator asked with ask_person (w1397, shared/ask.ts): the question, one button per option (its pick
 * first, marked Recommended) and "Chat more about this". A click sends the option as your own reply to the question
 * (POST /answer), and the buttons lock on the one picked, read back from the transcript so a reload, another tab and a
 * phone all show the same. "Chat more" sends nothing: it opens the reply box on the question. Typing an answer instead
 * works as ever and leaves the buttons as they are.
 *
 * Stills and clips the question or an option names as `![what it shows](<path>)` are shown (w1419, Ben: "I need to see
 * screenshots of what you're talking about", then "i dont see any previews"): the question's under it, an option's under
 * its button, never inside it (a click on a still opens it large; a click on the button answers). The words alone are the
 * button's text and the quote's.
 */
export function AskCard({ seq, ask, sessionId }: { seq: number; ask: Ask; sessionId: string }) {
  const chat = useContext(ChatActionsContext);
  // Which option of this question was clicked, read from the person's messages after it (-1: none yet).
  const chosen = useStore((s) => {
    const later = (s.transcripts[sessionId] ?? []).filter((e) => e.seq > seq && e.kind === 'user' && e.from === 'human') as { text: string }[];
    return answerOf(ask, seq, later, HELD_MARK)?.chosen ?? -1;
  });
  // The click in flight: the buttons are shut at once, before the transcript has the message.
  const [sending, setSending] = useState<number>(-1);
  // The click on its way is not cut off by a reload for a new version.
  useEffect(() => {
    holdReload(`ask:${sessionId}:${seq}`, sending >= 0 && chosen < 0);
    return () => holdReload(`ask:${sessionId}:${seq}`, false);
  }, [sessionId, seq, sending >= 0 && chosen < 0]);
  const picked = chosen >= 0 ? chosen : sending;
  const locked = picked >= 0;
  const live = !!chat?.interactive && !locked;
  const click = async (i: number) => {
    if (!live || sending >= 0) return;
    setSending(i);
    const ok = await attempt(api.answer(sessionId, seq, i));
    if (ok === undefined) setSending(-1);
  };
  const q = splitMedia(ask.question);
  return (
    <div className={`ask${locked ? ' ask-locked' : ''}`} data-seq={seq} data-testid="ask" role="group" aria-label={`Question: ${q.text}`}>
      <div className="ask-q">{q.text}</div>
      {q.media.length > 0 && (
        <div className="ask-media" data-testid="ask-media">
          <Markdown text={mediaMarkdown(q.media)} />
        </div>
      )}
      <div className="ask-options">
        {ask.options.map((o, i) => {
          const d = splitMedia(o.description);
          return (
          <div key={o.label} className="ask-opt-wrap">
          <button
            type="button"
            className={`ask-opt${o.recommended ? ' ask-rec' : ''}${picked === i ? ' ask-picked' : ''}`}
            data-testid="ask-option"
            disabled={!live}
            aria-pressed={picked === i}
            onClick={() => void click(i)}
          >
            <span className="ask-opt-head">
              <span className="ask-opt-label">{o.label}</span>
              {o.recommended && <span className="chip chip-amber ask-tag">Recommended</span>}
              {picked === i && (
                <span className="ask-chosen">
                  <Icon name="check" size={13} /> Your answer
                </span>
              )}
            </span>
            {d.text && <span className="ask-opt-desc">{d.text}</span>}
          </button>
          {d.media.length > 0 && (
            <div className="ask-media ask-opt-media" data-testid="ask-option-media">
              <Markdown text={mediaMarkdown(d.media)} />
            </div>
          )}
          </div>
          );
        })}
        {!locked && (
          <button
            type="button"
            className="ask-opt ask-more"
            data-testid="ask-more"
            disabled={!chat?.interactive}
            onClick={() => startReply(sessionId, { seq, from: 'Orchestrator', excerpt: ask.question })}
          >
            <span className="ask-opt-head">
              <Icon name="chat" size={14} />
              <span className="ask-opt-label">{CHAT_MORE_LABEL}</span>
            </span>
            <span className="ask-opt-desc">Type your own answer instead</span>
          </button>
        )}
      </div>
    </div>
  );
}
