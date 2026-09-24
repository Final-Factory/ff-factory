# Voice

Two ways to talk to agents, in every message box (the orchestrator chat, session views; the mic
also sits in the new-agent prompt and a standing agent's charter):

- **Dictation** (the mic, the default): speech becomes text in the box for the user to check and edit.
  It is sent only when the user presses Send, unless "Send automatically after dictation" is on.
- **Voice mode** (the Voice / wave button): hands-free, for the car. It listens, sends what the user
  said when they pause, reads the reply aloud, and listens again, until they say "stop" or tap the
  screen.

## Dictation

- **Desktop**: click the mic to start and click again (or **Done**) to stop, or hold it and let go.
  In a text box, **Ctrl+M** does the same (hold to talk, tap to toggle); **Esc** discards.
- **Phone**: tap to start, tap to stop.
- **Stops by itself** after the pause setting (default 1.8 s of silence once speech has started),
  and gives up after 10 s with no speech. A held mic ignores that and waits for the release.
- While recording, the bar shows a live dot, the elapsed time, a level meter, the engine, and
  Done / discard. Clips stop at 5 minutes.

## Voice mode

One tap on **Voice** opens a full-screen view with one big word: **Listening** (green), **Thinking**
(amber: transcribing, then waiting for the reply), **Speaking** (blue). The orb follows the mic
level. Short tones mark each step: a rising pair when it starts listening, a tick when a message is
sent, a soft tick every 8 s while the agent thinks, a falling pair at the end.

The loop (`web/src/voice/voiceMode.ts`):

1. Listen. The end-of-speech detector (below) finishes the utterance after the pause setting.
2. Transcribe with local Whisper. Empty: listen again. "Stop", "cancel", "that's all", "voice mode
   off" and the like (`isStopCommand`, `shared/speech.ts`): end voice mode.
3. Send it (no review step in this mode) and wait for that turn's `result` event. The reply is its
   last assistant message: the orchestrator's answer, or an agent's final message (`turnReply`).
4. Read it aloud, then listen again.

- **Barge-in**: while a reply plays the mic stays open; the user talking over it (8 dB louder than the
  normal start threshold, since the speaker's own echo leaks in) stops the playback, and what they
  say is taken as the next message. Settings can turn it off.
- While the agent thinks it keeps listening: "stop" works, and anything else is sent as a follow-up.
- Tap anywhere, Esc, 5 minutes without speech, or the mic being taken by a call ends it.

**iPhone.** Built for Safari and the Home Screen app:
- audio is unlocked inside the tap that starts voice mode (the AudioContext is created there, and
  an empty utterance unlocks speech synthesis);
- one mic stream and one AudioContext for the whole session, so the play-and-record audio session
  stays up and the mic is not re-opened (or re-prompted) between turns;
- replies play through that same context;
- the Wake Lock API keeps the screen on, and is taken again when the page comes back to the front.

**Reading replies** (`shared/speech.ts`, `web/src/voice/player.ts`). `speakableText` turns markdown
into speech:
- headings and bullets become sentences, links read as their text and bare URLs as "link";
- code blocks and tables become "Code block omitted." / "Table omitted.";
- hashes, UUIDs and long ids are dropped, paths read as their file name;
- past 1500 characters it stops at a sentence and says "The rest is on screen."

`speechChunks` sends the first sentence on its own and the second chunk small, so audio starts
while the rest is still being made. All chunks are requested at once and scheduled back to back.
Local Kokoro is the default; the browser's `speechSynthesis` is the fallback (and the choice in
Settings).

## Engines

| | engine | where |
|---|---|---|
| speech to text | faster-whisper `large-v3-turbo`, int8_float16 on the GPU (CPU fallback) | `server/voice/worker.py`, `POST /api/voice/transcribe` |
| text to speech | Kokoro-82M (`kokoro-v1.0.onnx`) on onnxruntime-gpu (CUDA), voice `af_heart` | `server/voice/tts_worker.py`, `POST /api/voice/tts` |
| fallbacks | the browser's `SpeechRecognition` / `speechSynthesis` | used when the local engine is not installed, or chosen in Settings |

Each engine is one Python worker, started on demand and ended after `voice.idleMinutes` (20)
without use, which frees its VRAM for the Unity editors. Recording start warms Whisper, and voice
mode warms both (`POST /api/voice/warm {tts}`), so the model loads while the user talks. Audio and text
go over the worker's stdin and are never written to disk, unless `voice.keepAudio` (debug) keeps
clips in `data/voice-debug/`. A GPU load that fails runs on the CPU.

**Recording** uses Web Audio, not MediaRecorder: the page captures PCM, downsamples it to 16 kHz
mono and uploads a WAV. Whisper wants exactly that, so the server needs no ffmpeg and never meets
Safari's mp4 or Chrome's webm.

**Whisper's vocabulary**: faster-whisper `hotwords`, which go into every 30 s window (an
`initial_prompt` only steers the first one). `buildVoicePrompt` (`shared/voice.ts`) builds it per
request:
- a fixed list of FF and portal words;
- `voice.vocabulary` from config;
- sandbox ids and machine ids;
- the newest spec numbers in the base clone;
- standing agent names and recent agent titles.

It is cut to ~600 characters. Timestamps stay on (without them a 45 s test clip lost a sentence at
the 30 s window boundary), and `vad_filter` cuts silence, where Whisper otherwise invents text.

## End-of-speech detection

`shared/vad.ts`, pure and shared by dictation and voice mode. Energy, not a model:
- each 20 ms frame is high-passed at 150 Hz (road rumble, engine hum), measured in dB, and compared
  with an **adaptive noise floor**: the minimum of the smoothed energy over the last 4 s. Speech
  always has gaps between words that fall back to the floor, so the floor follows the background (a
  quiet room, a car at speed), not the voice;
- speech starts when 140 ms of the last 300 ms are 9 dB over the floor;
- it ends after the pause setting with the ~130 ms-smoothed level under floor + 5 dB;
- under 300 ms of voice (a cough, a door) is dropped;
- digital silence (a mic warming up, a muted track) never feeds the floor, and nothing can start in
  the first 600 ms of real signal, while the browser's gain control and noise suppression settle.
- In voice mode, 500 ms of audio before the onset is kept, so the first word is not clipped.

Measured (TTS speech, synthetic car noise: brown rumble, a wandering ~30 Hz engine with harmonics,
tyre hiss, passing-truck swells, indicator clicks, road bumps; 3 noise seeds each):
- no false starts, misses or split utterances from 15 dB down to 0 dB SNR, including a 45 s clip
  with its natural pauses. At −3 dB SNR (noise louder than the voice, before any phone noise
  suppression) that clip splits in places.
- Ends land within 0.1 s of the pause setting.
- Noise alone (three levels) gives "no speech" at 10 s.
- Noise that jumps 17 dB mid-wait reads as one short false utterance (Whisper returns nothing for
  it, so nothing is sent), then adapts.
- In Edge with the fake-mic WAVs, dictation stops 1.6–1.8 s after the last word.

Tuning aid: `localStorage['ffsb.voice.debug'] = '1'` logs the detector's energy, floor and events
to the console.

## Settings

Per device, in Settings (the bell) → Voice input:

| setting | default |
|---|---|
| Engine (dictation) | Automatic: local Whisper, else the browser |
| Send automatically after dictation | off |
| Stop dictation by itself when I stop talking | on |
| Pause that ends speech | 1.8 s (1.0 / 1.5 / 1.8 / 2.5 / 3.5) |
| Read replies with | Automatic: local Kokoro, else the browser's voice |
| Voice | the server's `voice.ttsVoice` (`af_heart`); a shortlist of US/UK Kokoro voices |
| Speed | Normal (0.9× to 1.5×) |
| Talking over a reply interrupts it | on |

Server side, `config.json` → `voice` (`server/config.ts`):
- `enabled`, `model`, `device`, `computeType`, `language`;
- `idleMinutes` (20), `cpuThreads`, `autoInstall`, `keepAudio`, `vocabulary`, `uvPath`, `toolsDir`;
- `tts` (on), `ttsVoice` (`af_heart`), `ttsDevice` (`auto`).

## Install

`npm run voice-setup` is idempotent; `-- --force` reinstalls. It puts everything under
`voice.toolsDir` (default `data/tools/whisper`, ~5.6 GB). No admin, nothing system-wide; uv comes
from PATH or is downloaded into the folder.

- `venv/`: a uv-managed Python 3.12 with `server/voice/requirements.txt` (faster-whisper plus the
  CUDA 12 cuBLAS/cuDNN wheels, so no CUDA toolkit), and the Whisper model.
- `tts-venv/`: `server/voice/requirements-tts.txt`: Kokoro on onnxruntime-gpu with its CUDA 13
  wheels. It is a separate venv because onnxruntime-gpu cannot share one with the CPU onnxruntime
  that faster-whisper needs; the CPU package is excluded there. The Kokoro model comes from the
  kokoro-onnx GitHub release.
- `installed.json` stamps each part (requirements hash + model) as soon as it is done, so a
  text-to-speech failure never costs a working Whisper.

The server runs the same setup in the background at startup when a stamp is missing or stale
(`voice.autoInstall`), so an app update that changes the requirements or a model reinstalls without
holding up the restart. Meanwhile the status is `installing` and the browser engines are used.
Progress is in `data/tools/whisper/setup.log`. Settings shows both engines' status, and an install
button after a failure.

## Measured on the development PC (RTX 4080 SUPER, 2026-09-23)

| | GPU | CPU |
|---|---|---|
| Whisper, 6.5 s clip | 0.14-0.31 s | 5.5 s |
| Whisper, 45.5 s clip | 0.61-0.95 s | 12.4 s |
| Whisper load | 2.4-2.6 s with files cached; 12-15 s cold; 36 s once, the first load after a fresh install | 10.5 s |
| Kokoro, one short sentence | 0.13-0.2 s | 1.4 s |
| Kokoro, 250 characters (17 s of audio) | 1.0 s | ~5 s |
| Kokoro load | 0.9-3.8 s | 2 s |
| VRAM | Whisper ~1.1 GB, Kokoro ~0.9 GB, freed on unload | none |
| RAM (Whisper worker) | ~620 MB working set | similar |

In the browser (Edge, fake mic, mocked agent):
- the transcript is back 0.4-0.5 s after end-of-speech;
- a reply's first audio starts 0.2 s after the reply arrives;
- barge-in cuts playback ~0.4 s after the voice starts (the onset window plus one audio batch).
