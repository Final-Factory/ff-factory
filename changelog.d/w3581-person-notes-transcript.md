- **`orchestrator_transcript` shows a person's own messages as their chat does** (w3581, lothsahn: "when I message I
  don't need to see "held from a prior turn""). The remote tool printed each message's stored text, so FF Factory's
  "held from earlier turns" and open-questions notes showed after the person's words; it now reads them through
  `personMessageView` (shared/personMessage.ts). The orchestrator's own transcript reads keep the notes.
  Tests: `forgivingLimits.test.ts`.
