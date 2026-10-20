- **A chat at the bottom stays there in Safari when something above it draws smaller** (w1641): WebKit has no scroll
  anchoring, so a block above the view that drew smaller (the seeded chat's broken mermaid diagram showing its error) pulled
  scrollTop down to the new end, and a picture at the end that loaded before that scroll event was handled made the chat
  look scrolled up: it stopped following (`e2e/scrollKeep.spec.ts:91` failed on mobile-safari in CI, 184 and 2963 px short
  of the end). The chat now takes a scroll event that left its last row where it was on screen for the layout, not the
  reader, and keeps following.
