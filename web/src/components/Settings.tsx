import { useState } from 'react';
import { NOTIFY_KINDS, type AppVersion } from '../../../shared/types';
import { disablePush, enableInTab, enablePush, pushMode, setPref, testNotification, usePush } from '../notify';
import { api } from '../api';
import { attempt, logout, toast, toastError, useStore } from '../store';
import { SHORTCUT_LABEL, VOICE_PREF_DEFAULTS, refreshVoiceStatus, setVoicePrefs, useVoicePrefs, useVoiceStatus, type TtsEnginePref } from '../voice/dictation';
import { browserSpeechSupported } from '../voice/browserSpeech';
import type { VoiceEnginePref } from '../../../shared/voice';
import { Modal } from './ui';
import { versionLabel } from '../util';
import { VaultSettings } from './Vault';

/** This device's settings: notifications and voice input. */
export function SettingsModal({ app, onClose }: { app?: AppVersion; onClose: () => void }) {
  const p = usePush();
  const [testing, setTesting] = useState(false);
  const mode = pushMode(p);
  const on = mode === 'push';
  const inTab = mode === 'tab';
  const inTabCapable = !p.supported && !p.needsHomeScreen && p.permission !== 'unsupported' && p.permission !== 'denied';

  const status = p.needsHomeScreen
    ? 'On iPhone and iPad, add FF Factory to the Home Screen first (Share → Add to Home Screen), open it from there, then turn notifications on here.'
    : p.permission === 'denied'
      ? 'Notifications are blocked for this site. Allow them in the browser’s site settings, then come back.'
      : on
        ? 'On: this device gets notifications even when FF Factory is closed.'
        : inTab
          ? 'On in this tab only: this browser cannot receive push notifications, so this tab shows them while it is in the background, and you get none once it is closed.'
          : !p.supported
            ? 'This browser cannot receive push notifications. Allowing them lets this tab show them while it is in the background.'
            : 'Off on this device: no notifications, from the browser or from this page.';

  return (
    <Modal
      title="This device"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost danger-hover settings-signout" onClick={() => void logout()} title="Sign this browser out">
            Sign out
          </button>
          <span className="spacer" />
          {mode !== 'off' && (
            <button
              className="btn btn-ghost"
              disabled={testing}
              onClick={async () => {
                setTesting(true);
                try {
                  toast(await testNotification());
                } catch (e) {
                  toastError(e);
                } finally {
                  setTesting(false);
                }
              }}
            >
              Send a test
            </button>
          )}
          {p.supported && p.permission !== 'denied' && (
            <button className={`btn ${on ? 'btn-outline' : 'btn-primary'}`} disabled={p.busy} onClick={() => (on ? disablePush() : enablePush()).catch(toastError)}>
              {p.busy ? 'Working…' : on ? 'Turn off' : 'Turn on'}
            </button>
          )}
          {inTabCapable && (
            <button className={`btn ${inTab ? 'btn-outline' : 'btn-primary'}`} disabled={p.busy} onClick={() => (inTab ? disablePush() : enableInTab()).catch(toastError)}>
              {inTab ? 'Turn off' : p.permission === 'default' ? 'Allow in-tab notifications' : 'Turn on'}
            </button>
          )}
        </>
      }
    >
      <div className="form">
        <p className={`small ${on ? 'tone-green' : 'dim'}`}>{status}</p>
        <div className="field">
          <span>Tell me when</span>
          {NOTIFY_KINDS.map((k) => (
            <label key={k.value} className="check">
              <input type="checkbox" checked={p.prefs[k.value]} onChange={(e) => void setPref(k.value, e.target.checked).catch(toastError)} />
              <span>
                {k.label} <small className="dim">{k.hint}</small>
              </span>
            </label>
          ))}
        </div>
        <p className="dim small">These choices belong to this device; your phone and your desktop can differ. While the app is in front, nothing pops up.</p>
        <VoiceSettings />
        <PoolSettings />
        <VaultSettings />
        {app && (
          <div className="field about" data-testid="about-version">
            <span>About</span>
            <p className="small dim">
              FF Factory <span className="mono">{versionLabel(app)}</span> ·{' '}
              <a href="https://github.com/Final-Factory/ff-factory/blob/main/CHANGELOG.md" target="_blank" rel="noreferrer">
                changelog
              </a>
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * Whose Claude pool each person's work runs on (w1717, docs/vault.md section 4, "Picking another person's pool"): "self" by
 * default, or another person's pool. Anyone signed in may change anyone's; the server checks the pick.
 */
function PoolSettings() {
  const people = useStore((s) => s.app?.poolPeople);
  const pools = useStore((s) => s.app?.settings?.pool);
  if (!people?.length) return null;
  const poolOf = (userId: string) => Object.entries(pools ?? {}).find(([k]) => k.toLowerCase() === userId.toLowerCase())?.[1] ?? 'self';
  const nameOf = (userId: string) => people.find((o) => o.userId === userId)?.displayName ?? userId;
  return (
    <div className="field" data-testid="pool-settings">
      <span>Claude pool</span>
      <p className="small dim">
        Whose Claude tokens each person’s work runs on; Self is their own. Another person’s pool keeps its limits, and anyone signed in may change these.
      </p>
      <div className="pool-rows">
        {people.map((p) => {
          const value = poolOf(p.userId);
          const self = value.toLowerCase() === p.userId.toLowerCase() ? 'self' : value;
          const pick = (to: string) => void attempt(api.setPool(p.userId, to).then(() => toast(`${p.displayName}’s work: ${to === 'self' ? 'their own pool' : `${nameOf(to)}’s pool`}`)));
          return (
            <label key={p.userId} className="pool-row">
              <span>{p.displayName}’s work</span>
              <select className="input" value={self} onChange={(e) => pick(e.target.value)}>
                <option value="self">{p.hasPool ? 'Self' : 'Self (no token yet)'}</option>
                {people
                  .filter((o) => o.userId.toLowerCase() !== p.userId.toLowerCase() && (o.hasPool || o.userId.toLowerCase() === self.toLowerCase()))
                  .map((o) => (
                    <option key={o.userId} value={o.userId}>
                      {o.displayName}’s pool
                    </option>
                  ))}
              </select>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** English Kokoro voices worth offering (the model has more). */
const KOKORO_VOICES: [string, string][] = [
  ['af_heart', 'Heart (US, female)'],
  ['af_bella', 'Bella (US, female)'],
  ['af_nicole', 'Nicole (US, female, soft)'],
  ['am_michael', 'Michael (US, male)'],
  ['am_fenrir', 'Fenrir (US, male)'],
  ['am_puck', 'Puck (US, male)'],
  ['bf_emma', 'Emma (UK, female)'],
  ['bm_george', 'George (UK, male)'],
  ['bm_fable', 'Fable (UK, male)'],
];

function VoiceSettings() {
  const prefs = useVoicePrefs();
  const s = useVoiceStatus();
  const [installing, setInstalling] = useState(false);
  const own = s?.local ?? s;
  const ownLine = !own
    ? 'Local Whisper: status unknown (the server did not answer).'
    : own.state === 'ready'
      ? `Local Whisper (${own.model}): loaded on the ${own.device === 'cuda' ? 'GPU' : 'CPU'}.`
      : own.state === 'idle'
        ? `Local Whisper (${own.model}): installed; the model loads when you start talking and unloads when idle.`
        : own.state === 'loading'
          ? `Local Whisper (${own.model}): loading the model.`
          : own.state === 'installing'
            ? 'Local Whisper: first-time setup is downloading (a few minutes). Until then the browser’s speech recognition is used.'
            : `Local Whisper: unavailable${own.detail ? ` (${own.detail})` : ''}.`;
  // A worker machine's GPU Whisper (w615, docs/voice.md): first choice when it is up; the portal's own is the fallback.
  const r = s?.remote;
  const remoteLine = !r
    ? undefined
    : s?.local
      ? `Whisper on ${r.machine}’s GPU (${r.model}): ${r.state === 'ready' ? `loaded${r.vramMiB ? `, ${(r.vramMiB / 1024).toFixed(1)} GB of VRAM` : ''}` : r.state === 'loading' ? 'loading the model' : 'loads when you start talking'}. It takes your clips first.`
      : `Whisper on ${r.machine}: ${r.vramShort ? 'waiting for free VRAM' : r.state}${r.detail ? ` (${r.detail})` : ''}. The portal’s own Whisper takes your clips meanwhile.`;
  const last = s?.last;
  const lastLine = last
    ? `Last clip (${new Date(last.at).toLocaleTimeString()}): ${last.engine === 'remote' ? `${last.machine}’s ${last.device === 'cuda' ? 'GPU' : 'CPU'}` : `the portal’s own ${last.device === 'cuda' ? 'GPU' : 'CPU'}`} (${last.model}), ${last.totalSeconds.toFixed(1)} s for ${last.audioSeconds.toFixed(1)} s of audio${last.fallback ? `. Fell back because ${last.fallback}` : ''}.`
    : undefined;
  const whisper = [remoteLine, s?.local ? `Fallback: ${ownLine}` : ownLine, lastLine].filter(Boolean).join(' ');
  return (
    <div className="field">
      <span>Voice input</span>
      <p className="small dim">
        The mic in every message box: click it, or hold it to talk and let go to send it to the box; {SHORTCUT_LABEL} does the same while typing (Esc
        discards). On a phone, tap to start and tap to stop. The text lands in the box for you to check; audio is not kept.
      </p>
      <label className="voice-engine">
        <span>Engine</span>
        <select className="input" value={prefs.engine} onChange={(e) => setVoicePrefs({ engine: e.target.value as VoiceEnginePref })}>
          <option value="auto">Automatic: local Whisper, else the browser</option>
          <option value="whisper">Local Whisper only (private, knows FF words)</option>
          <option value="browser" disabled={!browserSpeechSupported()}>
            Browser speech recognition{browserSpeechSupported() ? '' : ' (not in this browser)'}
          </option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={prefs.autoSend} onChange={(e) => setVoicePrefs({ autoSend: e.target.checked })} />
        <span>
          Send automatically after dictation <small className="dim">off: the text waits in the box until you press Send</small>
        </span>
      </label>
      <p className={`small ${s?.state === 'ready' || s?.state === 'idle' ? 'tone-green' : 'dim'}`} data-testid="voice-engines">
        {whisper}
      </p>
      <label className="check">
        <input type="checkbox" checked={prefs.dictationAutoStop} onChange={(e) => setVoicePrefs({ dictationAutoStop: e.target.checked })} />
        <span>
          Stop dictation by itself when I stop talking <small className="dim">after the pause below; holding the mic always waits for the release</small>
        </span>
      </label>
      <label className="voice-engine">
        <span>Pause that ends speech</span>
        <select className="input" value={prefs.silenceMs} onChange={(e) => setVoicePrefs({ silenceMs: Number(e.target.value) })}>
          {[1000, 1500, 1800, 2500, 3500].map((ms) => (
            <option key={ms} value={ms}>
              {(ms / 1000).toFixed(1)} s{ms === VOICE_PREF_DEFAULTS.silenceMs ? ' (default)' : ms < 1500 ? ' (quick)' : ms > 2000 ? ' (for long pauses)' : ''}
            </option>
          ))}
        </select>
      </label>

      <span className="voice-sub">Voice mode (hands-free)</span>
      <p className="small dim">
        The Voice button (the wave icon) next to the mic: it listens, sends what you said when you pause, reads the reply aloud and listens again. Say “stop” or tap
        the screen to end it. It keeps the screen on while it runs.
      </p>
      <label className="voice-engine">
        <span>Read replies with</span>
        <select className="input" value={prefs.ttsEngine} onChange={(e) => setVoicePrefs({ ttsEngine: e.target.value as TtsEnginePref })}>
          <option value="auto">Automatic: local Kokoro, else the browser’s voice</option>
          <option value="local">Local Kokoro only</option>
          <option value="browser">The browser’s voice</option>
        </select>
      </label>
      <div className="field-row">
        <label className="voice-engine">
          <span>Voice</span>
          <select className="input" value={prefs.ttsVoice} onChange={(e) => setVoicePrefs({ ttsVoice: e.target.value })}>
            <option value="">Default{s?.tts ? ` (${KOKORO_VOICES.find(([v]) => v === s.tts.voice)?.[1] ?? s.tts.voice})` : ''}</option>
            {KOKORO_VOICES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="voice-engine">
          <span>Speed</span>
          <select className="input" value={prefs.ttsSpeed} onChange={(e) => setVoicePrefs({ ttsSpeed: Number(e.target.value) })}>
            {[0.9, 1, 1.15, 1.3, 1.5].map((x) => (
              <option key={x} value={x}>
                {x === 1 ? 'Normal' : `${x}×`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={prefs.bargeIn} onChange={(e) => setVoicePrefs({ bargeIn: e.target.checked })} />
        <span>
          Talking over a reply interrupts it <small className="dim">turn off if the phone’s speaker keeps cutting itself off</small>
        </span>
      </label>
      <p className={`small ${s?.tts.state === 'ready' || s?.tts.state === 'idle' ? 'tone-green' : 'dim'}`}>
        {!s
          ? ''
          : s.tts.state === 'ready'
            ? `Local Kokoro: loaded on the ${s.tts.device === 'cuda' ? 'GPU' : 'CPU'}.`
            : s.tts.state === 'idle'
              ? 'Local Kokoro: installed; loads when voice mode starts.'
              : s.tts.state === 'loading'
                ? 'Local Kokoro: loading.'
                : s.tts.state === 'installing'
                  ? 'Local Kokoro: installing. Until then the browser’s voice reads replies.'
                  : `Local Kokoro: unavailable${s.tts.detail ? ` (${s.tts.detail})` : ''}; the browser’s voice reads replies.`}
      </p>
      {s?.state === 'unavailable' && /setup failed|voice-setup/.test(s.detail ?? '') && (
        <button
          type="button"
          className="btn btn-outline btn-xs"
          disabled={installing}
          onClick={async () => {
            setInstalling(true);
            try {
              await api.voiceInstall();
              toast('Installing local Whisper in the background');
            } catch (e) {
              toastError(e);
            } finally {
              setInstalling(false);
              refreshVoiceStatus(0);
            }
          }}
        >
          Install local Whisper
        </button>
      )}
    </div>
  );
}
