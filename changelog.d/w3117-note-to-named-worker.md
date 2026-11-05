- **A person's note on a request with several workers goes to the worker it names** (w3117, after w2895: Ben's note for
  worker aa60d124 and ffu #202 went to b4440e1e as the answer to its open [needs you], and b4440e1e asked Ben again). With
  more than one worker still on the request, update_work sends the note to the workers it names, by session id (its first 8
  characters) or by a pull request number their own title, last report or open wait names too, and it answers only the named
  worker's question: the answer to the [needs you] when that worker holds it, else `[answer]` to the named worker's own
  declared wait, else a `[note]` that says it is not an answer to another worker's question. A note that names none of them
  goes to nobody: the orchestrator is told whose question it would settle and calls update_work again naming the worker. With
  one worker nothing changes. Tests: `needsYou.test.ts` and `orchestrators.test.ts` ("w3117").
