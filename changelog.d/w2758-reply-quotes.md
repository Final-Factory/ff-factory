- **A reply between people shows the message it answers** (w2758, lothsahn: "the operator should see the message
  replied to as well as the reply"). Each `[person message]` names its id; message_person takes `reply_to` with those
  ids, or FF Factory infers the one it answers (the message the person replied to in their chat, else the open ones,
  several shown as "maybe"). The recipient sees the answered message quoted above the reply in their chat and in the
  bubble over their message box, and their orchestrator reads it in the `[person message]` text. Reply from the bubble
  quotes the message it was opened on. Needs a portal deploy.
