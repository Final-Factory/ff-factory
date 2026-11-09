- **The spend file no longer holds the portal for a second or two on each save** (w3855, for ben: in the 13 minutes after
  the f4c644f restart on 2026-11-09 the event loop stood 1.0-2.2 s six times, each in spend.json's serialize). The
  background save builds `spend.json` a request or session at a time and lets the event loop run every 25 ms
  (`durable.ts` `stringifyObjectSliced`, `SnapshotFile`'s `serializeAsync`); the file is the same, byte for byte, and a
  shutdown still writes it in one go.
