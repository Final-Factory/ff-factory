- **A daemon disconnect no longer freezes the portal while its held messages are walked** (w6513, option B of w6455). At
  15:44Z on 2026-11-27 the drain held the portal's event loop for 5.0 s while lothdesktop's daemon was away: for each held
  message it counted every machine's mid-turn agents again, scanned the ledger twice, and, after each failed send to the
  offline machine, emptied the memo so the next message rebuilt places and claims. Within a drain pass each machine's
  counts now come from one walk of the sessions, the hold and fresh-start checks read the pass's per-worker index, and a
  machine found offline keeps the memo for the rest of the pass. The same messages are held and released as before
  (server/loopBlocks.test.ts); in the bench a held-only drain pass went from 117-269 ms to 10-32 ms.
