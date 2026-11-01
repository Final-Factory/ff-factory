import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { enterAction } from '../../../shared/keys';
import { PERSON_MESSAGE_CHARS } from '../../../shared/replies';
import type { PersonMessageMark, SessionInfo } from '../../../shared/types';
import { api } from '../api';
import { holdReload } from '../freshness';
import { useKeptState } from '../keep';
import { attempt, focusEvent, hidePersonMessages, useStore } from '../store';
import { fmtClock, fmtRelative, useNow } from '../util';
import { onScreenKeyboard } from '../viewport';
import { useTextareaDictation } from '../voice/useTextareaDictation';
import { AnsweredQuotes } from './AnsweredQuotes';
import { Markdown } from './Markdown';
import { DictationBar, MicButton } from './Mic';
import { Icon } from './ui';

/** How long a clear can be undone before the server hears of it. */
export const UNDO_MS = 6000;

const idOf = (m: PersonMessageMark) => m.id ?? m.at;

/** The messages still unread here: those the bubble cleared and can still undo are left out (the sidebar's count too). */
export function unreadHere(list: readonly PersonMessageMark[] | undefined, clearing: readonly string[] | undefined): PersonMessageMark[] {
  return (list ?? []).filter((m) => !clearing?.includes(idOf(m)));
}

/** How long "Sent to <name>" stays in the bubble after a reply (w1831). */
export const SENT_MS = 4000;

/** After Undo, Clear all comes back where Undo was: a second tap there in this time does nothing. */
const UNDO_SETTLE_MS = 700;

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
  // The message whose reply box is open (w1831): one at a time.
  const [replying, setReplying] = useState<string | null>(null);
  // Who a reply just went to: said in the bubble's own status line for a few seconds, where the person is looking (a toast
  // lay over the message box on a phone), and the bubble stays for it when that message was the last one.
  const [sent, setSent] = useState<string | null>(null);
  const sentTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(sentTimer.current), []);
  const replied = (name: string) => {
    setReplying(null);
    setSent(name);
    clearTimeout(sentTimer.current);
    sentTimer.current = setTimeout(() => setSent(null), SENT_MS);
  };
  // The clear that can still be undone: those ids are hidden here, and sent when the time is up.
  const [undo, setUndo] = useState<{ ids: string[]; timer: ReturnType<typeof setTimeout> } | null>(null);
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const now = useNow(60_000);
  const toggle = useRef<HTMLButtonElement>(null);
  // After Undo, Clear all shows no hover under the still pointer (it would look chosen) until the pointer leaves it.
  const [calm, setCalm] = useState(false);
  const undoneAt = useRef(0);
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

  // Cleared here, in the undo window or sent: hidden in the bubble and the sidebar's count alike. A sent one stays hidden
  // until the server's update drops it (no flash back); a refused clear shows it again.
  const hidden = useStore((s) => s.clearing[session.id]);
  const send = (ids: string[]) => void attempt(api.readPersonMessages(session.id, ids)).then((ok) => ok === undefined && hidePersonMessages(session.id, ids, false));
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
    hidePersonMessages(session.id, ids, true);
  };
  const takeBack = () => {
    if (!undo) return;
    clearTimeout(undo.timer);
    setUndo(null);
    hidePersonMessages(session.id, undo.ids, false);
    undoneAt.current = Date.now();
    setCalm(true);
    // Not left on Clear all, which comes back where Undo was.
    requestAnimationFrame(() => toggle.current?.focus({ preventScroll: true }));
  };

  const list = unreadHere(all, hidden);
  // Gone by itself once nothing is unread here (cleared in another tab or on the phone too).
  useEffect(() => {
    if (!list.length) setOpen(false);
  }, [list.length]);
  const cleared = undo ? all.filter((m) => undo.ids.includes(idOf(m))).length : 0;
  if (!list.length && !cleared && !sent) return null;

  const latest = list.at(-1);
  const clearAll = (
    <button
      type="button"
      className={`btn btn-ghost btn-sm pmsg-clear-all${calm ? ' pmsg-calm' : ''}`}
      onPointerLeave={() => setCalm(false)}
      onClick={() => Date.now() - undoneAt.current > UNDO_SETTLE_MS && clear(list.map(idOf))}
      title="Mark them all read: they stay in the chat, and your orchestrator has them">
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
                      {/* One group, kept whole: on a narrow phone it goes under the name rather than squeezing it (w1831). */}
                      <span className="pmsg-actions">
                        {seq !== undefined && (
                          <button type="button" className="btn btn-ghost btn-xs" onClick={() => focusEvent(session.id, seq)} title="Go to this message in the conversation">
                            Show in chat
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          aria-expanded={replying === idOf(m)}
                          onClick={() => setReplying((r) => (r === idOf(m) ? null : idOf(m)))}
                          title={`Answer ${m.from.displayName} here: it goes straight to them, and shows in your chat`}
                          aria-label={`Reply to ${m.from.displayName}`}
                          data-testid="pmsg-reply">
                          <Icon name="reply" size={13} /> Reply
                        </button>
                        <button type="button" className="btn btn-ghost btn-xs" onClick={() => clear([idOf(m)])} title="Mark it read: it stays in the chat, and your orchestrator has it" aria-label={`Clear the message from ${m.from.displayName}`}>
                          <Icon name="check" size={13} /> Clear
                        </button>
                      </span>
                    </div>
                    <AnsweredQuotes answers={m.answers} whose="your" />
                    <div className="pmsg-text">{m.text ? <Markdown text={m.text} /> : <p className="pmsg-old">Sent before this box kept the words: it is in the conversation above.</p>}</div>
                    {replying === idOf(m) && <ReplyBox sessionId={session.id} mark={m} onClose={() => setReplying(null)} onSent={replied} />}
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
        {sent && (
          <div className="pmsg-undo pmsg-sent" role="status" data-testid="people-messages-sent">
            <Icon name="check" size={13} />
            <span>Sent to {sent}: it is in your chat too.</span>
          </div>
        )}
      </section>
    </div>
  );
});

/**
 * The reply box under a message from another person (w1831, Ben: "give me a fast way to reply to him in there (including with
 * voice) and replying in there sends the message to loth as normal"): the chat box's mic and Enter, and Send, which delivers
 * the words straight to that person as message_person does (server Orchestrators.replyToPerson), with no turn of the
 * orchestrator in between. They show in this chat as the person's own message, and the message they answer is read.
 */
function ReplyBox({ sessionId, mark, onClose, onSent }: { sessionId: string; mark: PersonMessageMark; onClose: () => void; onSent: (name: string) => void }) {
  const [text, setText] = useKeptState(`pmsg.reply.${idOf(mark)}`, '');
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  // One id per message written: a send repeated after an answer that never came is taken once (as the chat box's).
  const clientId = useRef<string | null>(null);
  const send = async (words = text.trim()) => {
    if (!words || sending) return;
    clientId.current ??= crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setSending(true);
    const ok = await attempt(api.replyToPerson(sessionId, idOf(mark), words, clientId.current));
    setSending(false);
    if (ok === undefined) return;
    clientId.current = null;
    setText('');
    onSent(mark.from.displayName);
  };
  // "Send automatically after dictation" sends what was dictated, as in the chat box.
  const voice = useTextareaDictation({ value: text, setValue: setText, ref: box, onAutoSend: (t) => void send(t.trim()) });
  useEffect(() => {
    holdReload(`pmsg-reply:${idOf(mark)}`, sending);
    return () => holdReload(`pmsg-reply:${idOf(mark)}`, false);
  }, [sending]);
  // Into the box at once, but not on a phone, where the keyboard would cover the message and the mic.
  useEffect(() => {
    if (!window.matchMedia('(pointer: coarse)').matches) box.current?.focus({ preventScroll: true });
  }, []);
  // The box grows with what is typed or dictated, a few lines at most, so it is read whole before Send (as w1817's).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + el.offsetHeight - el.clientHeight, 160)}px`;
  }, [text]);
  const label = `Reply to ${mark.from.displayName}`;
  return (
    <div className="pmsg-reply" data-testid="pmsg-reply-box">
      <div className="pmsg-reply-row">
        <textarea
          ref={box}
          data-kept
          className="input pmsg-reply-text"
          rows={1}
          placeholder={label}
          aria-label={label}
          value={text}
          maxLength={PERSON_MESSAGE_CHARS}
          onChange={(e) => setText(e.target.value)}
          {...voice.textareaProps}
          onKeyDown={(e) => {
            if (voice.keyDown(e)) return;
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
              return;
            }
            // The chat box's keys (Composer): Enter sends, Shift+Enter is a new line; with a phone's own keyboard, Send sends.
            const touch = window.matchMedia('(pointer: coarse)').matches && onScreenKeyboard();
            const act = enterAction(
              { key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode },
              { touch, canSend: !!text.trim() },
            );
            if (act === 'default') return;
            e.preventDefault();
            if (act === 'send') void send();
            if (act === 'newline') {
              const el = e.currentTarget;
              el.setRangeText('\n', el.selectionStart, el.selectionEnd, 'end');
              setText(el.value);
            }
          }}
        />
        <MicButton d={voice.d} className="pmsg-reply-mic" />
        <button
          type="button"
          className={`btn pmsg-reply-send ${text.trim() ? 'btn-primary' : 'btn-outline'}`}
          disabled={!text.trim() || sending}
          onClick={() => void send()}
          data-testid="pmsg-reply-send"
          title={`Send to ${mark.from.displayName} (Enter; Shift+Enter for a new line)`}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
      <DictationBar d={voice.d} />
    </div>
  );
}
