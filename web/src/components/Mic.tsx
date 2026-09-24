import { useRef } from 'react';
import { fmtElapsed } from '../../../shared/voice';
import { SHORTCUT_LABEL, type Dictation } from '../voice/dictation';
import { Icon } from './ui';

/**
 * The mic button. Mouse: press and hold to talk (letting go stops), or click to start and click
 * again to stop. Touch: tap to start, tap to stop (a click is the gesture iOS accepts for audio).
 */
export function MicButton({ d, className = '' }: { d: Dictation; className?: string }) {
  const mouse = useRef(false);
  const on = d.phase === 'recording' || d.phase === 'starting';
  return (
    <button
      type="button"
      className={`btn btn-ghost btn-icon btn-mic${on ? ' recording' : ''}${d.phase === 'transcribing' ? ' busy' : ''} ${className}`}
      title={on ? 'Stop and transcribe' : `Dictate: click, or hold to talk (${SHORTCUT_LABEL} in the text box)`}
      aria-label={on ? 'Stop dictation' : 'Dictate'}
      aria-pressed={on}
      disabled={d.phase === 'transcribing'}
      onPointerDown={(e) => {
        mouse.current = e.pointerType === 'mouse';
        if (!mouse.current || e.button !== 0) return;
        // Keep the caret in the text box.
        e.preventDefault();
        d.press();
      }}
      onPointerUp={(e) => {
        if (e.pointerType === 'mouse') d.release();
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse' && e.buttons) d.release();
      }}
      onClick={() => {
        // Mouse presses were handled on pointerdown; touch taps and the keyboard land here.
        if (mouse.current) {
          mouse.current = false;
          return;
        }
        d.press();
      }}
    >
      {d.phase === 'transcribing' ? <span className="spinner" /> : <Icon name="mic" size={16} />}
    </button>
  );
}

/** While dictating: a live dot, the timer, a level meter, which engine, and stop / cancel. Errors show here too. */
export function DictationBar({ d }: { d: Dictation }) {
  if (d.phase === 'idle') return null;
  if (d.phase === 'error') {
    return (
      <div className="dictation-bar dictation-error" role="alert">
        <Icon name="mic" size={14} />
        <span className="dictation-msg">{d.error}</span>
        {d.canRetry && (
          <button type="button" className="btn btn-xs btn-outline" onClick={d.retry}>
            Retry
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-icon btn-xs" onClick={d.dismiss} aria-label="Dismiss">
          <Icon name="x" size={12} />
        </button>
      </div>
    );
  }
  const recording = d.phase === 'recording';
  return (
    <div className="dictation-bar" aria-live="polite">
      <span className={`rec-dot${recording ? ' live' : ''}`} />
      <span className="mono dictation-time">{d.phase === 'transcribing' ? 'Transcribing…' : d.phase === 'starting' ? 'Opening mic…' : fmtElapsed(d.elapsedMs)}</span>
      {d.engine === 'whisper' ? (
        <span className="level-meter" aria-hidden>
          <span style={{ transform: `scaleX(${recording ? Math.max(0.03, d.level) : 0})` }} />
        </span>
      ) : (
        <span className="dictation-interim">{d.interim || (recording ? 'Listening…' : '')}</span>
      )}
      <span className="dictation-engine small dim" title={d.label}>
        <span className="engine-long">{d.label}</span>
        <span className="engine-short">{d.engine === 'browser' ? 'Browser' : 'Whisper'}</span>
      </span>
      {recording && (
        <button type="button" className="btn btn-xs btn-stop" onClick={d.stop} title="Stop and transcribe">
          <Icon name="stop" size={12} /> Done
        </button>
      )}
      <button type="button" className="btn btn-ghost btn-icon btn-xs" onClick={d.cancel} title="Discard (Esc)" aria-label="Discard dictation">
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
