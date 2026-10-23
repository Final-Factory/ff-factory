// w1829 (the bench-lock demo) as the ledger cleanup saw it at 15:39 UTC on 2026-10-23, when it closed it as done (w1870):
// its PRs #548 and #556 had merged and the portal ran them, but its worker 17e0097f's last turn had ended in
// error_during_execution partway through the demo lothsahn asked for. That error was the dispatcher's own interrupt: it
// stopped the worker on LothDesktop, which lothsahn had reserved for w1785, and queued w1829 for BEAST at 15:35. lothsahn
// reopened it by hand at 15:39. Times, ids and words are the ledger's (read_work w1829); the brief is cut to its goal and
// done criteria.
import type { SessionInfo, WorkItem, WorkPr } from '../shared/types.ts';

export const W1829_AT = {
  filed: '2026-10-23T06:43:00.000Z',
  /** Its worker's last report before the demo: still open, waiting for a demo slot. */
  report: '2026-10-23T10:20:00.000Z',
  /** The dispatcher queued it for BEAST. */
  queued: '2026-10-23T15:35:00.000Z',
  /** The worker's turn ended in error_during_execution: the dispatcher's interrupt. */
  error: '2026-10-23T15:38:00.000Z',
  /** The ledger cleanup's pass that closed it. */
  closed: '2026-10-23T15:39:24.000Z',
};

/** The portal's commit then (3f30ecd), which contains both merges. */
export const W1829_PORTAL = '3f30ecd';
export const W1829_MERGES = { 548: '3e224b0f'.padEnd(40, '0'), 556: '7d346fd37333'.padEnd(40, '0') };

export const W1829_PRS: WorkPr[] = [
  { repo: 'Final-Factory/ff-factory', number: 548, state: 'merged', at: '2026-10-23T08:19:00.000Z', sha: W1829_MERGES[548], via: 'line' },
  { repo: 'Final-Factory/ff-factory', number: 556, state: 'merged', at: '2026-10-23T11:23:00.000Z', sha: W1829_MERGES[556], via: 'line' },
];

export const W1829_REQUEST: Partial<WorkItem> & Pick<WorkItem, 'id'> = {
  id: 'w1829',
  title: 'Bench lock: quiet other editors and players on the machine during an exclusive timed ticket',
  brief: [
    'Goal: when a timed bench leg holds the exclusive ticket on a machine, the machine is actually quiet.',
    '',
    'What lothsahn said: "Fix the lock to pause other editors and players".',
    '',
    'Done when:',
    '- The change is merged on green CI and deployed by the normal auto-deploy.',
    '- On a real machine with at least two other editors busy, a timed leg\'s quiet gate opens with no NOGATE.',
    '- Editors resume normally afterwards: show one compiling or playing again.',
    '- A ticket holder killed mid-leg still releases everything.',
  ].join('\n'),
  priority: 'urgent',
  status: 'queued',
  queuedFor: { at: W1829_AT.queued, needs: ['beast'] },
  createdAt: W1829_AT.filed,
  updatedAt: W1829_AT.error,
  sessionIds: ['17e0097f'],
  prs: W1829_PRS,
  notes: [{ at: '2026-10-23T15:35:00.000Z', by: 'lothsahn', text: 'Demo location, lothsahn verbatim: "Run the w1829 demo on BEAST now".' }],
  log: [
    '10:20 worker 17e0097f: w1829: still open: blocked on the dispatcher booking a LothDesktop demo slot with dec9a619 (w1785\'s worker), with at least 2 other editors busy',
    '11:23 PR #556 merged; still open: its brief asks for a step after the merge (a check, an audit, a verification)',
    '15:35 dispatcher: queued for capacity on beast: w1829 (bench lock quieting other editors during a timed ticket)',
    '15:38 worker 17e0097f: stopped: error_during_execution',
  ],
};

/** Its worker after the dispatcher's interrupt: idle on LothDesktop, its last result the CLI's error, stopped on purpose. */
export const W1829_WORKER: Partial<SessionInfo> & Pick<SessionInfo, 'id'> = {
  id: '17e0097f',
  kind: 'worker',
  title: 'w1829: FF Factory bench lock: pause other editors and players',
  status: 'idle',
  machineId: 'lothdesktop',
  machineSandbox: 'slot2',
  createdAt: W1829_AT.filed,
  lastActivityAt: W1829_AT.error,
  lastResult: 'stopped: error_during_execution',
  lastResultAt: W1829_AT.error,
  stoppedOnPurpose: true,
};
