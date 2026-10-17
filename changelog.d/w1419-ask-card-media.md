- **A question with buttons shows its stills and clips** (w1419, Ben: "I need to see screenshots of what you're talking
  about", then "i dont see any previews"). Since w1397 the orchestrator asks every question with `ask_person`, and its card
  printed `![Option A at 1280](</srv/fff/review/…png>)` as text. The card now shows a question's media under it and an
  option's under its button (the same inline images and players as a message), and the length limits count words only, so
  a path is never cut. A new e2e test checks a review PNG, WebM and MP4 load in a plain orchestrator message (before and after
  a reload) and in a card, on desktop and phone. Docs: orchestrators.md ("Questions with buttons"). Tests:
  `e2e/images.spec.ts` (w1419), `ask.test.ts`.
