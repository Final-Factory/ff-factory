- **A question is asked once, and never again once answered** (w1812, Ben: "i already answered this why are you asking me
  in the waiting on input for this still"). One question from one worker that shows on several of its requests (one
  `waiting_on_person` naming no request, or the same `still open` line) goes as ONE `[needs you]`, on the first request,
  naming the others; an answer on any of them (an `update_work` note, a card button) marks all of them answered, resumes the
  worker once, and none of them stays Waiting on input. No `[needs you]` goes when the person's answer, given after the
  question was raised, is already in the request's log or in the log of another request the same worker holds with that
  question. An orchestrator's `ask_person`, or the dispatcher's `decide_work ask`, that repeats a question the person already
  answered is refused once with their words (a repeat of the call goes through, for a new question that only looks the
  same). Questions that differ between requests are sent as before. The personal orchestrator's brief says to check the
  request's log and its worker's other requests before asking. Docs: orchestrators.md ("Questions for a person"). Tests:
  `orchestrators.test.ts` and `workState.test.ts` ("w1812").
