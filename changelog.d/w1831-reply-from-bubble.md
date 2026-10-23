- **Reply to another person straight from the bubble over your message box, with voice** (w1831, Ben: "give me a fast way
  to reply to him in there (including with voice) and replying in there sends the message to loth as normal"). Each
  message from another person in the amber bubble has **Reply**: a box with the chat's dictation mic and Send (Enter sends,
  Shift+Enter is a new line, as in the chat box). Send delivers the words at once, with no orchestrator turn in between,
  exactly as message_person does: the other person gets the same message, unread mark and notification. The reply shows in
  your chat as your own message, quoting the one it answers, with a "Sent to <name>" tag. Your orchestrator reads it there
  and is told it is already sent. The answered message leaves the bubble, which says "Sent to <name>" for a few seconds. New route
  `POST /api/sessions/:id/person-messages/reply`. Docs: orchestrators.md ("Reply from the bubble"). Tests:
  `server/orchestrators.test.ts`, `server/replies.test.ts`, `e2e/orchestrators.spec.ts`.
