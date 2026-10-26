- **A pair run's legs keep their sandboxes until the run is over** (w2305): the release no longer takes the sandbox of a leg
  that waits on its partner, has a check-in pending or idles between turns, and no longer reads its partner as "another
  worker", so w2304's re-queue no longer kills healthy runs; a re-queue stops its old legs at once.
