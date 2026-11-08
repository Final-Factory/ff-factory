- **Voice input shows your words while you talk** (w3712, Ben: "Can you just make it real time?"). In the chat boxes and
  the question cards' answer boxes, the text grows about once a second while the mic records. On stop, the full-clip
  Whisper pass replaces it with the final transcript, and Discard or Esc puts the box back.
  - Measured with real CPU Whisper (base.en, 2 threads, the setup used when BEAST is offline): first words 1.6 s after
    the mic opened, then an update every 0.9 s.
  - Live passes decode greedily on BEAST and on the portal's CPU, so the daemon needs its update for that part. An older
    daemon still answers, with its full beam search.
  - The final pass's log line now says how the live passes went.
  - Fixes a bug that sent zeros for the newest audio of a live pass.
  - Docs: voice.md, "Live text while you talk". Tests: `liveTranscript.test.ts`, `machineVoice.test.ts`, `e2e/voice.spec.ts`.
