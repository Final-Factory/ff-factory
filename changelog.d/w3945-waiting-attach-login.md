- **The Waiting on input attachment tests run on a login of their own** (w3945): other e2e files' cards on the owner's
  tab moved the paperclip between mousedown and mouseup, the click landed beside it and no file chooser opened (one WebKit
  CI failure). `docs/ci.md` names the cause; `CONTRIBUTING.md`'s own-login rule now covers the Waiting tab and how to tell
  a click lost to a layout shift.
