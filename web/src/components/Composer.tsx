import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionInfo } from '../../../shared/types';
import { api } from '../api';
import type { ImageInput } from '../../../shared/types';
import { attempt, toast, toastError } from '../store';
import { enterAction } from '../../../shared/keys';
import { FREE_TEXT, isBusy, lsGet, lsSet, shrinkImage, useMediaQuery } from '../util';
import { useTextareaDictation } from '../voice/useTextareaDictation';
import { useVoicePrefs } from '../voice/dictation';
import { DictationBar, MicButton } from './Mic';
import { VoiceModeButton, VoiceModeOverlay, useVoiceMode } from './VoiceMode';
import { Icon } from './ui';

export function Composer({
  session,
  size = 'normal',
  placeholder,
  prefill,
  onPrefillUsed,
  autoFocus,
}: {
  session: SessionInfo;
  size?: 'normal' | 'large';
  placeholder?: string;
  /** Text pushed in from outside (e.g. a suggestion chip). */
  prefill?: string | null;
  onPrefillUsed?: () => void;
  /** Put the caret here when the conversation opens (desktop only: on a phone it would pop the keyboard). */
  autoFocus?: boolean;
}) {
  const key = `ffsb.draft.${session.id}`;
  const [text, setText] = useState(() => lsGet(key) ?? '');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [images, setImages] = useState<(ImageInput & { key: number })[]>([]);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const busy = isBusy(session);
  // Phones and tablets: Enter inserts a new line (there is no Shift), the button sends.
  const touch = useMediaQuery('(pointer: coarse)');
  // Standing agents take text only (their runs are budgeted text turns); everyone else takes images.
  const canAttach = session.kind !== 'standing';

  const addFiles = async (files: Iterable<File>) => {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    if (images.length + list.length > 8) return toast('At most 8 images per message', 'error');
    setReading((n) => n + list.length);
    for (const f of list) {
      try {
        const img = await shrinkImage(f);
        setImages((xs) => [...xs, { ...img, key: Math.random() }]);
      } catch (e) {
        toastError(e);
      } finally {
        setReading((n) => n - 1);
      }
    }
  };

  useEffect(() => {
    lsSet(key, text);
  }, [key, text]);

  useEffect(() => {
    if (prefill) {
      setText(prefill);
      onPrefillUsed?.();
      requestAnimationFrame(() => {
        ta.current?.focus();
        ta.current?.setSelectionRange(prefill.length, prefill.length);
      });
    }
  }, [prefill, onPrefillUsed]);

  useEffect(() => {
    if (!busy) setStopping(false);
  }, [busy]);

  useEffect(() => {
    if (autoFocus && !touch && !document.querySelector('.overlay')) ta.current?.focus({ preventScroll: true });
  }, [autoFocus, touch, session.id]);

  // Auto-grow.
  // Auto-grow up to a cap, then scroll. The cap also follows the visible viewport, so with the
  // on-screen keyboard open (or in landscape) the box never pushes the conversation off screen.
  const [viewH, setViewH] = useState(() => window.visualViewport?.height ?? window.innerHeight);
  useEffect(() => {
    const vv = window.visualViewport;
    const on = () => setViewH(vv?.height ?? window.innerHeight);
    (vv ?? window).addEventListener('resize', on);
    return () => (vv ?? window).removeEventListener('resize', on);
  }, []);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    const cap = Math.max(72, Math.min(size === 'large' ? 320 : 220, Math.round(viewH * 0.35)));
    el.style.height = 'auto';
    const fits = el.scrollHeight <= cap;
    // Exactly the content's height while it fits: nothing to scroll, nothing to bounce.
    el.style.height = (fits ? el.scrollHeight : cap) + 'px';
    el.style.overflowY = fits ? 'hidden' : 'auto';
    if (fits) el.scrollTop = 0;
  }, [text, size, viewH]);

  // The box itself never moves under a finger: a drag on it is cancelled unless it is inside the
  // text box and that has more text than it shows.
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onMove = (e: TouchEvent) => {
      const t = (e.target as Element | null)?.closest('textarea');
      if (t && t.scrollHeight > t.clientHeight + 1) return;
      if (e.cancelable) e.preventDefault();
    };
    box.addEventListener('touchmove', onMove, { passive: false });
    return () => box.removeEventListener('touchmove', onMove);
  }, []);

  /** `override`: the text to send instead of the box's (auto-send after dictation, before the state lands). */
  const send = async (override?: string) => {
    const t = (override ?? text).trim();
    if ((!t && !images.length) || sending || reading) return;
    setSending(true);
    const ok = await attempt(api.sendMessage(session.id, t, images.map(({ mediaType, data }) => ({ mediaType, data }))));
    setSending(false);
    if (ok !== undefined) {
      setText('');
      setImages([]);
    }
    if (ok?.note) toast(ok.note);
    ta.current?.focus();
  };

  const voiceMode = useVoiceMode(session);
  const hasContent = !!text.trim() || images.length > 0;
  const { bargeIn } = useVoicePrefs();
  const voice = useTextareaDictation({ value: text, setValue: setText, ref: ta, onAutoSend: (t) => void send(t) });

  const stop = async () => {
    setStopping(true);
    // A standing agent's Stop ends its run (and books it), rather than leaving the process idle mid-run.
    const ok = await attempt(session.standingId ? api.stopStanding(session.standingId) : api.interrupt(session.id));
    if (ok === undefined) setStopping(false);
  };

  const hint =
    session.kind === 'standing'
      ? session.status === 'stopped' || session.status === 'error'
        ? 'Asleep between runs. A message starts a run, with the same budget and agent limit.'
        : null
      : session.status === 'stopped'
      ? 'Session stopped. Sending a message resumes it.'
      : session.status === 'error'
        ? 'Session errored. Sending a message tries to resume it.'
        : null;

  return (
    <div className={`composer composer-${size}`}>
      {voiceMode.view && <VoiceModeOverlay title={session.kind === 'orchestrator' ? 'Orchestrator' : session.title} view={voiceMode.view} level={voiceMode.level} onEnd={voiceMode.end} bargeIn={bargeIn} />}
      {hint && <div className="composer-hint">{hint}</div>}
      <div
        ref={boxRef}
        className={`composer-box${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          if (!canAttach || !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false);
          if (!canAttach || !e.dataTransfer.files.length) return;
          e.preventDefault();
          void addFiles(e.dataTransfer.files);
        }}
      >
        {(images.length > 0 || reading > 0) && (
          <div className="composer-images">
            {images.map((img) => (
              <span key={img.key} className="composer-image">
                <img src={`data:${img.mediaType};base64,${img.data}`} alt="" />
                <button className="composer-image-x" onClick={() => setImages((xs) => xs.filter((x) => x.key !== img.key))} aria-label="Remove image">
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
            {reading > 0 && (
              <span className="composer-image composer-image-busy">
                <span className="spinner" />
              </span>
            )}
          </div>
        )}
        <DictationBar d={voice.d} />
        <textarea
          ref={ta}
          {...FREE_TEXT}
          {...voice.textareaProps}
          aria-label={placeholder ?? 'Message'}
          rows={1}
          value={text}
          placeholder={busy && !session.standingId ? 'Add a follow-up…' : (placeholder ?? 'Message…')}
          enterKeyHint={touch ? 'enter' : 'send'}
          onChange={(e) => setText(e.target.value)}
          onScroll={(e) => {
            // A text box that fits its content has nothing to scroll (the browser may still try, revealing the caret).
            const el = e.currentTarget;
            if (el.style.overflowY === 'hidden' && el.scrollTop) el.scrollTop = 0;
          }}
          onPaste={(e) => {
            if (!canAttach) return;
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
            if (!files.length) return;
            e.preventDefault();
            void addFiles(files);
          }}
          onKeyDown={(e) => {
            if (voice.keyDown(e)) return;
            const act = enterAction(
              { key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode },
              { touch, canSend: !!text.trim() || images.length > 0 },
            );
            if (act === 'default') return;
            e.preventDefault();
            if (act === 'send') void send();
            // Ctrl/Cmd+Enter: a textarea ignores it, so insert the newline (execCommand keeps undo working).
            if (act === 'newline' && !document.execCommand('insertText', false, '\n')) {
              const el = e.currentTarget;
              el.setRangeText('\n', el.selectionStart, el.selectionEnd, 'end');
              setText(el.value);
            }
          }}
        />
        <div className="composer-actions">
          {canAttach && (
            <>
              <button className="btn btn-ghost btn-icon" onClick={() => picker.current?.click()} title="Attach images (or paste / drop them)" aria-label="Attach images">
                <Icon name="paperclip" size={16} />
              </button>
              <input
                ref={picker}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </>
          )}
          <span className="composer-spacer" />
          {busy && hasContent && (
            <button className="btn btn-ghost btn-icon btn-stop-mini" onClick={stop} disabled={stopping} title="Stop the current turn" aria-label="Stop">
              <Icon name="stop" size={15} />
            </button>
          )}
          {busy && !hasContent && !sending && <VoiceModeButton onStart={voiceMode.start} ghost />}
          <MicButton d={voice.d} />
          {/* One primary slot, as in the ChatGPT and Claude apps: Send when there is something to send, Stop while a turn runs, else voice mode. */}
          {hasContent || sending ? (
            <button
              className="btn btn-primary btn-icon btn-send"
              onClick={() => void send()}
              disabled={sending || reading > 0}
              title={touch ? 'Send' : busy ? 'Send (it waits for the current turn)' : 'Send (Enter; Shift+Enter for a new line)'}
              aria-label="Send"
            >
              {sending ? <span className="spinner spinner-dark" /> : <Icon name="send" size={18} />}
            </button>
          ) : busy ? (
            <button className="btn btn-icon btn-stop-main" onClick={stop} disabled={stopping} title={stopping ? 'Stopping…' : 'Stop the current turn'} aria-label="Stop">
              {stopping ? <span className="spinner spinner-dark" /> : <Icon name="stop" size={16} />}
            </button>
          ) : (
            <VoiceModeButton onStart={voiceMode.start} />
          )}
        </div>
      </div>
    </div>
  );
}
