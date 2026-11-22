- **A message's pictures page through in the viewer** (w5151, lothsahn: "When you give me a set of windows please give me
  right and left links to go to the next and previous picture in FF factory"). The stills and clips written into one
  message (an orchestrator's reply, a report, an ask_person card's preview, a waiting card) now open in the lightbox as one
  set: left and right arrows and the Left and Right keys step through them, the bar shows "2 / 3", Esc closes. Before, each
  inline picture opened alone, so the lightbox's arrows never showed for them. At an end the arrow stays in place, dimmed
  and disabled (no wrap). A one-picture message shows no arrows. The arrows get a visible bordered pill. Test:
  `e2e/images.spec.ts` ("a message's pictures page through").
