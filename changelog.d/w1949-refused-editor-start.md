- **A worker stopped after its editor start was refused for want of a Unity slot shows Blocked, not Working** (w1949;
  lothsahn confirmed the scope: lock, editor and partner waits show as Blocked, not Working). A `unity start` refused by the
  machine's Unity slots leaves no queue entry, so the request read Working on its retry check-in. The portal now keeps the
  refusal on the worker's session; while the worker is stopped with a check-in and its machine's daemon still reports no
  slot free, work that needs an editor reads "Blocked on a Unity editor slot on <machine> (3 of 3 in use)", and Working once
  a slot frees or its next turn opens. Docs: orchestrators.md ("Ledger"). Tests: `w1949QueueWaits.test.ts`.
