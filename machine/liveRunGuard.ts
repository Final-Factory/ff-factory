// w6378: a release or clean-up that would hit a sandbox while a run of its worker still lives there. On 2026-11-27 the
// nightly e2e (w6357, worker 0e4d75cd) waited for its bench turn in lothdesktop/slot2 when its worker's check-in came at
// 10:00:56 UTC. The portal restarted that idle worker's agent host on the machine's new FF Factory code (w1166 codeMove),
// the old host closed, and the pool's next look saw slot2 with no live agent: it sent it to 'cleanup' ("trimming the
// Library caches (released)"), refused the new host's start three seconds later, and its release sweep removed
// Builds/cache/b19302c0...-win, the night's own player build. A night is a process the worker started (nohup ... &
// disown), not an agent, so the pool's only test, "no live agent there", never saw it.
//
// lothsahn's lockout rule: this first step only says so (a WARNING line in the daemon log); the trim, the sweep and the
// release go ahead as before. Enforcing (the sandbox kept while the run lives) is a later, separate change.
//   daemon.json `liveRunGuard`: "warn" (unset: the default) logs; "off" looks at nothing, the way back with nobody at the
//   machine (`ops_worker machine_update live_run_guard off`, or the installer's --live-run-guard / -LiveRunGuard).

export type LiveRunGuardMode = 'off' | 'warn';

/** daemon.json `liveRunGuard`: off, or warn (unset or anything else: warn, the safe default that changes nothing). */
export function liveRunGuardModeOf(v: unknown): LiveRunGuardMode {
  return v === 'off' ? 'off' : 'warn';
}

/** What would hit the sandbox: a trim (and its release sweep), a release from the pool, or a delete. */
export type LiveRunAction = `Library cache trim (${string})` | 'release' | 'delete';

/** The WARNING line for the daemon's log, or undefined when no run lives there. */
export function liveRunWarning(id: string, action: LiveRunAction, holders: string[]): string | undefined {
  if (!holders.length) return undefined;
  return `WARNING sandbox ${id}: ${action} while a run of its worker still lives there: ${holders.join('; ')}. liveRunGuard warn: it goes ahead as before (w6378); a later change keeps the sandbox until the run ends`;
}
