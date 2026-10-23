- **The Waiting on input cards take files and pasted images** (w1912, Ben: "i need to be able to attach files or paste images
  to the waiting on input fields"). The answer box of a request's card and of a question your orchestrator asks has a
  paperclip, takes a pasted screenshot (Ctrl/Cmd+V) and a dropped file, and shows each as a chip (a picture as its own
  thumbnail) with a remove control before Send. The files upload through the chat box's own uploader, with its size and
  count limits, and go with the answer: the message your orchestrator gets lists them under `[attachments]` with their
  ids to hand to the request's worker, and a click on one of the answers carries them too (`POST /api/sessions/<id>/answer`
  takes `attachments`). A file alone is an answer. An intake card's decline reason takes no files: a declined request goes
  nowhere. Details: docs/attachments.md, "In the question cards".
