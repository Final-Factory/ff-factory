- **Messages between people stay in a bubble over the message box until you clear them** (w1546, lothsahn: "we're
  missing chat messages to each other when there's a lot of stuff from you and we haven't checked our messages in a
  while"). A `[person message]` that Ben's or Lothsahn's orchestrator sends the other now waits, unread, in an amber
  bubble right over the recipient's message box, on a desktop and on a phone. It shows the count and the sender. Unfolded,
  it shows each message in full with its time, Show in chat, and Clear. Clear all is on the bar. Opening the chat,
  writing to it, or the orchestrator relaying the message no longer marks it read. Clearing only marks a message read: it
  stays in the conversation, and the orchestrator already has it. A clear can be undone for 6 seconds. The bubble updates
  live and goes by itself once nothing is unread. New route `POST /api/sessions/:id/person-messages/read`. The old
  `/seen` route now reads nothing. Needs a portal deploy. Docs: orchestrators.md ("The bubble over the message box").
