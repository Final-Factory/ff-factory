- **The portal logs every event-loop block of 1 s or more, and says how the loop did every 10 minutes** (w2044): `event loop:
  blocked for` and the stall profile now start at 1 s (were 2 s and 3 s), the target in CONTRIBUTING.md "Performance", and
  `event loop: worst block 0.3 s in the last 10 min; 0 of 1 s or more` is logged every 10 minutes, so a quiet stretch is
  measured rather than read from missing lines.
