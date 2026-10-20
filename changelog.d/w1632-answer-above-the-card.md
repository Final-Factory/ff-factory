- **A turn that answers and then asks shows the answer, not only the card** (w1632, lothsahn: "you didn't answer my
  question in our chat ... And instead you posted a question for me ... make sure that you both answer my question and ask
  me the question"). The answer was in the chat all along, above the ask_person card: the chat followed its end, and on a
  phone the card filled the screen, so the answer sat above the top edge with nothing pointing at it. Now, when a turn's text
  and the card it ends on do not fit on the screen together, the chat starts at that text, the card below it and the "New
  messages" pill pointing down to it, once per card (scrolling down to the card stays there). A card the person has answered,
  or one with no text before it in its turn, follows the end as before. Web app only; it shows after a portal deploy. Docs:
  orchestrators.md ("Questions with buttons"). Tests: `e2e/ask.spec.ts` (the phone and desktop legs, in a chat of its own,
  login "asker").
