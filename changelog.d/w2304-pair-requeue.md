- **A pair run that loses a leg mid-run is re-queued whole** (w2304): when a person starts playing on a leg's computer (the
  w1894 player-yield), a leg's computer is offline 10 min, or a leg's sandbox went to other work, FF Factory stops every leg
  and Queues the run again (off the computer that yielded), so its legs start fresh and together instead of the request
  sitting Stalled. A leg of a run under way keeps its sandbox while the other legs work, and the w2046 move never moves it
  alone. At most 3 re-queues per run.
