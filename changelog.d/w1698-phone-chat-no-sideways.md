- **A phone's chat scrolls only up and down** (w1698, Ben: "it's letting me scroll horizontally slightly in this chat window ... It
  should only scroll vertically"). On a phone-width screen (860 px and under) a code block wraps its long lines instead of panning
  inside its box, and the chat's own scroller no longer pans sideways (its `overflow-y: auto` made its `overflow-x` auto too).
  Desktop is unchanged. `e2e/sideways.spec.ts` fills a chat with code, a table, a long path, an image, a clip, a diagram and an
  ask_person card at 375 and 390 px and checks that the page, the chat and every box in it have nothing to pan sideways.
