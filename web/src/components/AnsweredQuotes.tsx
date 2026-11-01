import type { Answered } from '../../../shared/replies';
import { fmtClock } from '../util';
import { Icon } from './ui';

/** Its time today, else its day too: an answer can come a day later. */
function when(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime()) || d.toDateString() === new Date().toDateString()) return fmtClock(iso);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * The recipient's own messages another person's message answers (w2758, shared/replies.ts answeredText), drawn above its
 * words in the chat's [person message] notice and in the bubble over the message box. `whose` names the recipient as the
 * reader sees them: "your" in their own chat.
 */
export function AnsweredQuotes({ answers, whose }: { answers?: readonly Answered[]; whose: string }) {
  if (!answers?.length) return null;
  return (
    <div className="answered-quotes" data-testid="answered-quotes">
      {answers.map((a, i) => (
        <blockquote key={i} className={`answered-quote${a.sure ? '' : ' maybe'}`} data-testid="answered-quote">
          <span className="answered-quote-head">
            <Icon name="reply" size={12} /> {a.sure ? 'In answer to' : 'Maybe in answer to'} {whose} message ·{' '}
            <time dateTime={a.at} title={new Date(a.at).toLocaleString()}>
              {when(a.at)}
            </time>
          </span>
          <span className="answered-quote-text">{a.excerpt || '(no text)'}</span>
        </blockquote>
      ))}
    </div>
  );
}
