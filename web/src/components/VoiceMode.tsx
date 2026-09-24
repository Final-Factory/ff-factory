import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionInfo } from '../../../shared/types';
import { api } from '../api';
import { toast } from '../store';
import { VoiceModeController, type VoiceModeView } from '../voice/voiceMode';
import { Icon } from './ui';

/** Voice mode for one session. start() must run inside the tap (iOS unlocks audio only there). */
export function useVoiceMode(session: SessionInfo) {
  const [view, setView] = useState<VoiceModeView | null>(null);
  const ctl = useRef<VoiceModeController | null>(null);

  const start = useCallback(() => {
    if (ctl.current) return;
    const c = new VoiceModeController({
      sessionId: session.id,
      send: async (text) => {
        const r = await api.sendMessage(session.id, text);
        if (r?.note) toast(r.note);
        return true;
      },
      onChange: (v) => {
        if (ctl.current === c) setView(v);
      },
      onEnd: (reason) => {
        if (ctl.current !== c) return;
        ctl.current = null;
        setView(null);
        toast(reason);
      },
    });
    ctl.current = c;
    c.start();
  }, [session.id]);

  const end = useCallback(() => ctl.current?.end(), []);
  const level = useCallback(() => ctl.current?.level() ?? 0, []);
  // Leaving the page ends it (and frees the mic).
  useEffect(() => () => ctl.current?.end('Voice mode off.'), []);
  return { view, start, end, level };
}

const LABEL: Record<VoiceModeView['state'], [string, string]> = {
  starting: ['Starting', 'Opening the microphone'],
  listening: ['Listening', 'Go ahead'],
  hearing: ['Listening', 'Hearing you'],
  transcribing: ['Thinking', 'Transcribing'],
  thinking: ['Thinking', 'Waiting for the reply'],
  speaking: ['Speaking', 'Talk to interrupt'],
  ended: ['Voice mode off', ''],
};

const TONE: Record<VoiceModeView['state'], string> = {
  starting: 'thinking',
  listening: 'listening',
  hearing: 'hearing',
  transcribing: 'thinking',
  thinking: 'thinking',
  speaking: 'speaking',
  ended: 'thinking',
};

/** Full screen while voice mode runs: one big word to glance at, the orb follows the mic. A tap anywhere ends it. */
export function VoiceModeOverlay({
  title,
  view,
  level,
  onEnd,
  bargeIn,
}: {
  title: string;
  view: VoiceModeView;
  level: () => number;
  onEnd: () => void;
  bargeIn: boolean;
}) {
  const orb = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (orb.current) orb.current.style.setProperty('--lvl', level().toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [level]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onEnd();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onEnd]);
  const [word, sub] = LABEL[view.state];
  const engines = `${view.stt === 'whisper' ? 'Whisper' : 'Browser'} → ${view.tts === 'browser' ? 'browser voice' : 'Kokoro'}`;
  const t = view.timings;
  return (
    <div className={`voice-mode vm-${TONE[view.state]}`} role="dialog" aria-label="Voice mode" aria-live="polite" onClick={onEnd}>
      <div className="vm-top">
        <span className="vm-title">{title}</span>
        <span className="vm-engines">{engines}</span>
      </div>
      <div className="vm-center">
        <div className="vm-orb" ref={orb} />
        <div className="vm-word" data-testid="vm-state">
          {word}
        </div>
        <div className="vm-sub">{view.state === 'speaking' && !bargeIn ? 'Reading the reply' : sub}</div>
      </div>
      <div className="vm-text">
        {view.heard && <div className="vm-heard">“{view.heard}”</div>}
        {view.reply && view.state === 'speaking' && <div className="vm-reply">{view.reply}</div>}
        {view.note && <div className="vm-note">{view.note}</div>}
      </div>
      <div className="vm-foot">
        Tap anywhere or say “stop” to end
        {t && (t.transcribeMs !== undefined || t.firstAudioMs !== undefined) && (
          <span className="vm-timings">
            {t.transcribeMs !== undefined && ` · heard in ${(t.transcribeMs / 1000).toFixed(1)} s`}
            {t.firstAudioMs !== undefined && ` · voice in ${(t.firstAudioMs / 1000).toFixed(1)} s`}
          </span>
        )}
      </div>
    </div>
  );
}

/** Hands-free voice mode: the composer's primary button while the box is empty (Send takes its place when there is text). */
export function VoiceModeButton({ onStart }: { onStart: () => void }) {
  return (
    <button type="button" className="btn btn-icon btn-voice-mode" onClick={onStart} title="Voice mode: talk hands-free, replies read aloud" aria-label="Voice mode">
      <Icon name="wave" size={18} />
    </button>
  );
}
