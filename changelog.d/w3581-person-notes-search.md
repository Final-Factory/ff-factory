- **A person's message is searched, and shown in the remote inbox, as their chat shows it** (w3581, lothsahn: "when I
  message I don't need to see "held from a prior turn""). Transcript search matched and quoted FF Factory's notes after a
  person's words (the held calls, the open questions, a reply's quote); `orchestrator_inbox` kept the "already sent" note.
  Both now read the words through `personMessageView` (shared/personMessage.ts), as the chat bubble has since w3297.
  Tests: `search.test.ts`.
