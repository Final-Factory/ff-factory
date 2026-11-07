- **A pair run Ben cleared to run without Steam leaves its Steam block with no re-filing** (w3455, ben: "Yes, no Steam: start
  the planner rejoin run now"). #866 fixed how new Steam marks are made, but w3431 and w3392 kept marks stored before it, so
  they stayed Blocked on Steam sign-ins. The blocker watch and decide_work now restate a stored mark that says "none" or was
  read only from FF Factory's own filing text, and drop its Steam gate. A person's words in `override_gate` that rule Steam
  out ("no Steam", "without Steam", "non-Steam") set the pair run's Steam need to none, as `pair_steam: "none"` does; the
  dispatcher's tool now describes `pair_steam`.
