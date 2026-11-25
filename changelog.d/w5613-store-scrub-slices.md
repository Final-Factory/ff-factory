- **The held records' secret scrub at start yields too** (w5613). After the a1701f9 deploy, the start still logged a 1.1 s
  block, 0.6 s of it in `Store.scrubSecrets` walking every session and work item held (journal, 2026-11-25 09:33Z). It now
  runs in 20 ms slices with the event loop between them; one record is never split. Test: `server/scrubSecrets.test.ts`.
