- **A machine that goes offline before its update reaches it stays due, not FAILED** (w2005). On 2026-10-24 m3 stopped
  answering at 06:49:19Z, 17 s before the rollout sent it 1cd675e75a; its daemon never fetched the bundle, yet the rollout
  waited 12 minutes, tried an ssh rollback of a machine nothing had touched ("ssh: connect to host m3 port 22: Connection
  timed out"), reported it FAILED and needing a person, and would not have updated it when it came back. The portal now
  records whether a machine fetched the bundle it was offered (`UpdateBundles.fetched`); an unanswered link update on a
  machine that is offline and never fetched it throws `UpdateNotReached`, and the rollout keeps that machine pending ("offline
  before the update reached it") and updates it after its next hello. Docs: ops-worker.md ("After a verified deploy").
  Tests: `machineRollout.test.ts`, `machineLink.test.ts`.
