- **A request's question can be handed to another person, and it stays with them** (w2867; lothsahn: "the request list in
  the dispatcher says it's waiting on input from me. Make sure that the state is reflected correctly and fix the issue
  causing the state to be attributed wrong"). Before this, the requester's "Ask ben" note on w2850 answered the question and
  reopened the request. The undecided re-offer (w2217) then had the dispatcher ask again, and `decide_work ask` always went
  to the requester, so the request read "Waiting on input on lothsahn" and the `[needs you]` came back to them.
  - New `update_work question_for: "<person>"` (with `already_asked: true` when they already have it: nothing is sent).
    The request stays the requester's. Its question waits on that person: the live state, the `[needs you]` and the Waiting
    tab all go to them. Their note answers it; anyone else's note is recorded and keeps it with them. The requester's own
    name takes it back.
  - `decide_work ask` takes `for`, and refuses an ask without it while the question is handed on.
  - FFBox does not post a thread question that was handed to someone other than the requester.
  - w2850's question is moved to Ben once at boot, with its text and answers unchanged and no message sent.
  - Needs a portal deploy.
