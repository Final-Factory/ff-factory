import { memo, useEffect, useRef, useState } from 'react';
import type { PersonMessageMark, SessionInfo } from '../../../shared/types';
import { api } from '../api';
import { attempt, focusEvent, useStore } from '../store';
import { fmtClock, fmtRelative, useNow } from '../util';
import { Markdown } from './Markdown';
import { Icon } from './ui';

/** How long a clear can be undone before the server hears of it. */
export const UNDO_MS = 6000;

const idOf = (m: PersonMessageMark) => m.id ?? m.at;

/** "Ben", "Ben and Cara", "Ben, Cara and Dee": who the unread messages are from, in the order they came. */
export function senders(list: readonly PersonMessageMark[]): string {
  const names = [...new Set(list.map((m) => m.from.displayName))];
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Messages other people sent you (message_person), over your own chat's message box (w1546, lothsahn: "we're missing
 * chat messages to each other when there's a lot of stuff from you and we haven't checked our messages in a while").
 * Each stays here, unread, until you clear it: opening the chat, writing to it, or your orchestrator relaying the message
 * leave it. Clearing only marks it read (the portal never holds one back: it is in your orchestrator's input as soon as it
 * is sent), and can be undone for a few seconds before the server hears of it. Live through the session event; a page
 * closed within those seconds leaves the message unread.
 */
export const PeopleMessages = memo(function PeopleMessages({ session }: { session: SessionInfo }) {
  const all = session.personMessages ?? [];
  const [open, setOpen] = useState(false);
  // The clear that can still be undone: those ids are hidden here, and sent when the time is up.
  const [undo, setUndo] = useState<{ ids: string[]; timer: ReturnType<typeof setTimeout> } | null>(null);
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const now = useNow(60_000);
  const toggle = useRef<HTMLButtonElement>(null);
  // A message's own notice in the transcript, for "Show in chat" (only while that part of the transcript is loaded),
  // looked up only while the bubble is open: the store changes with every streamed word.
  const seqOf = useStore((s) => {
    const out: Record<string, number> = {};
    const events = open ? s.transcripts[session.id] : undefined;
    if (!events) return '';
    for (const m of all) {
      if (!m.text) continue;
      const e = events.findLast((x) => x.kind === 'user' && x.from === 'system' && x.text.startsWith('[person message]') && x.text.includes(m.text!));
      if (e) out[idOf(m)] = e.seq;
    }
    return JSON.stringify(out);
  });
  const seqs = (seqOf ? JSON.parse(seqOf) : {}) as Record<string, number>;

  const send = (ids: string[]) => void attempt(api.readPersonMessages(session.id, ids));
  // Leaving the chat with a clear pending carries it out: the person asked for it.
  useEffect(
    () => () => {
      const u = undoRef.current;
      if (!u) return;
      clearTimeout(u.timer);
      send(u.ids);
    },
    [session.id],
  );

  const clear = (ids: string[]) => {
    if (!ids.length) return;
    const prev = undoRef.current;
    if (prev) clearTimeout(prev.timer);
    const both = [...(prev?.ids ?? []), ...ids];
    const timer = setTimeout(() => {
      setUndo(null);
      send(both);
    }, UNDO_MS);
    setUndo({ ids: both, timer });
  };
  const takeBack = () => {
    if (!undo) return;
    clearTimeout(undo.timer);
    setUndo(null);
    // Not left on Clear all, which comes back where Undo was.
    requestAnimationFrame(() => toggle.current?.focus({ preventScroll: true }));
  };

  const list = all.filter((m) => !undo?.ids.includes(idOf(m)));
  // Gone by itself once nothing is unread here (cleared in another tab or on the phone too).
  useEffect(() => {
    if (!list.length) setOpen(false);
  }, [list.length]);
  const cleared = undo ? all.filter((m) => undo.ids.includes(idOf(m))).length : 0;
  if (!list.length && !cleared) return null;

  const latest = list.at(-1);
  const clearAll = (
    <button type="button" className="btn btn-ghost btn-sm pmsg-clear-all" onClick={() => clear(list.map(idOf))} title="Mark them all read: they stay in the chat, and your orchestrator has them">
      <Icon name="check" size={14} /> Clear all
    </button>
  );
  const count = `${list.length} ${list.length === 1 ? 'message' : 'messages'} from ${senders(list)}`;
  return (
    <div className="pmsg-wrap">
      <section className={`pmsg${open ? ' open' : ''}`} data-testid="people-messages" aria-label="Messages from people">
        {latest && (
          <div className="pmsg-bar">
            <button ref={toggle} type="button" className="pmsg-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={open ? 'Fold the messages' : 'Read the messages'}>
              <span className="pmsg-icon" aria-hidden>
                <Icon name="chat" size={15} />
              </span>
              <span className="pmsg-count" data-testid="people-messages-count">
                {count}
              </span>
              {!open && <span className="pmsg-preview hide-phone">{latest.text ? latest.text.replace(/\s+/g, ' ') : 'Open to read'}</span>}
              {!open && (
                <time className="hide-phone" dateTime={latest.at} title={fmtClock(latest.at)}>
                  {fmtRelative(latest.at, now)}
                </time>
              )}
              <span className="pmsg-chev" aria-hidden>
                <Icon name="chevron" size={14} />
              </span>
            </button>
            {/* Open, Clear all moves to the foot: a row's Clear never lands on it as the list shrinks under the pointer. */}
            {!open && clearAll}
          </div>
        )}
        {open && list.length > 0 && (
          <>
            <ol className="pmsg-list">
              {list.map((m) => {
                const seq = seqs[idOf(m)];
                return (
                  <li key={idOf(m)} className="pmsg-item" data-testid="people-message">
                    <div className="pmsg-head">
                      <span className="pmsg-from">{m.from.displayName}</span>
                      <time dateTime={m.at} title={fmtClock(m.at)}>
                        {fmtRelative(m.at, now)}
                      </time>
                      <span className="pmsg-spacer" />
                      {seq !== undefined && (
                        <button type="button" className="btn btn-ghost btn-xs" onClick={() => focusEvent(session.id, seq)} title="Go to this message in the conversation">
                          Show in chat
                        </button>
                      )}
                      <button type="button" className="btn btn-ghost btn-xs" onClick={() => clear([idOf(m)])} title="Mark it read: it stays in the chat, and your orchestrator has it" aria-label={`Clear the message from ${m.from.displayName}`}>
                        <Icon name="check" size={13} /> Clear
                      </button>
                    </div>
                    <div className="pmsg-text">{m.text ? <Markdown text={m.text} /> : <p className="pmsg-old">Sent before this box kept the words: it is in the conversation above.</p>}</div>
                  </li>
                );
              })}
            </ol>
            <div className="pmsg-foot">
              <p>Clearing marks a message read. It stays in the conversation, and your orchestrator already has it.</p>
              {clearAll}
            </div>
          </>
        )}
        {cleared > 0 && (
          <div className="pmsg-undo" role="status" data-testid="people-messages-undo">
            <span>
              Cleared {cleared} {cleared === 1 ? 'message' : 'messages'}: still in the conversation.
            </span>
            <button type="button" className="btn btn-ghost btn-xs" onClick={takeBack}>
              Undo
            </button>
          </div>
        )}
      </section>
    </div>
  );
});
