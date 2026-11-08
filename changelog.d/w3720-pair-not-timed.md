- w3720: only timing work is timed. A pair run is timed only by request_pair `timed` (its words and notes are never read
  for timing), a note that denies timing ("not a timing run", "needs no bench lock") beats the older words that named it,
  and decide_work `timed` says it outright (w3705, a determinism pair, was barred from m5 and then every non-Mac by notes
  that quoted another request's timed run).
