// Today's waiting cards (w1868, 2026-10-23), the ones lothsahn named as impossible to answer, rebuilt from the ledger as
// read_work showed them that afternoon: the words are the ledger's (a line the ledger had cut off with "…" is finished in
// the same sense and marked so), the review paths stand for the requests' published stills and clips. The unit test
// (server/waitSummary.test.ts) and the screenshot test (e2e/intake.spec.ts) both read it.
import type { Ask } from '../../shared/ask.ts';
import type { OpenAsk, Requester, SessionInfo, WorkItem } from '../../shared/types.ts';
import type { WorkLive } from '../../shared/workState.ts';

export const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
export const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };

const ago = (now: number, min: number) => new Date(now - min * 60_000).toISOString();
const hhmm = (iso: string) => iso.slice(11, 16);

/** The frame look and the Station strip (w1821): two questions of one worker, each with its stills. */
export const FRAME_ASK: Ask = {
  question: 'How solid should a window frame be where windows stack? ![Both frames over Select Recipe at 1920x1080](</srv/fff/review/w1821-frames/frames-1920.png>)',
  options: [
    { label: 'Keep frames see-through over space, solid only over a window', description: 'Today’s look over the world; nothing of a covered window reads through. One shader change, about an hour.', recommended: true },
    { label: 'Make every frame fully solid', description: 'Simplest; the world no longer shows through any window frame.' },
  ],
};
export const STRIP_ASK: Ask = {
  question: 'When a window covers the Station strip, what should come up over it? ![Station Grid over the strip at 1280x800](</srv/fff/review/w1821-frames/strip-1280.png>)',
  options: [
    { label: 'The whole strip comes up over the window', description: 'Move, Land, Copy, Deconstruct and Hide stay usable and read as one bar.', recommended: true },
    { label: 'Only the Hide button comes up over the window', description: 'The smallest change; the rest of the strip stays covered.' },
  ],
};

const base = (now: number, id: string, extra: Partial<WorkItem>): WorkItem =>
  ({
    id,
    title: id,
    brief: '',
    priority: 'normal',
    keys: [],
    requestedBy: LOTH,
    requesters: [LOTH],
    humanAsked: true,
    status: 'active',
    createdAt: ago(now, 600),
    updatedAt: ago(now, 30),
    sessionIds: [],
    overlaps: [],
    asks: 0,
    log: [],
    ...extra,
  }) as WorkItem;

export interface WaitingCase {
  /** What lothsahn found wrong with its card. */
  was: string;
  w: WorkItem;
  live: WorkLive;
  /** Its worker, as the ledger had it. */
  session?: Pick<SessionInfo, 'id' | 'status' | 'waitingOn' | 'lastResult'>;
}

/** The cases, at `now`. */
export function waitingCases(now: number): WaitingCase[] {
  const sent1797 = ago(now, 460);
  const sent1829 = ago(now, 70);
  return [
    {
      was: 'cut off with "…" (w1797): "Watch the new w1797 braking clip … the two-machine check…"',
      w: base(now, 'w1797', {
        title: 'Discord bug: Disable Transit should let ship slow down until fullstop instead of instant zero velocity',
        brief: 'ben acknowledged this report as a bug in its thread (their own reply, matched to them by their Discord author id), so it is their own request, approved by that reply (w1783). Fix it.',
        requestedBy: BEN,
        requesters: [BEN],
        source: { kind: 'discord-bug', untrusted: true, channel: '#bug-reports', reporter: 'Reteoteigam', url: 'https://discord.com/channels/530867164866150410/1562541845555445852' },
        sessionIds: ['1c3fb56c'],
        log: [`${hhmm(sent1797)} worker 1c3fb56c: w1797: still open: waiting on Ben to OK the 1.5 s braking clip, then merge PR #2250`, `${hhmm(sent1797)} [needs you] sent to ben's orchestrator: Watch the new w1797 braking clip …`],
        needsYou: {
          key: 'declared:1c3fb56c:x',
          kind: 'declared',
          // The ledger cut this line at "the two-machine check…"; finished here in the same sense (reconstructed).
          question:
            'Watch the new w1797 braking clip (the station now slows evenly to rest in 1.5 s after Disable Transit, instead of about 4 s) and say whether it is right; the two-machine check passed, so PR #2250 merges on your OK. ![The 1.5 s brake](</srv/fff/review/w1797-braking/brake-1.5s.mp4>)',
          who: ['Ben'],
          to: ['ben'],
          at: sent1797,
          raisedAt: sent1797,
          worker: '1c3fb56c',
          previews: ['/srv/fff/review/w1797-braking/brake-1.5s.mp4'],
          prs: ['Final-Factory/FinalFactory#2250'],
        },
      }),
      live: { state: 'waiting', why: '1c3fb56c waits on Ben: Watch the new w1797 braking clip …', waitsOn: ['Ben'], worker: '1c3fb56c' },
      session: { id: '1c3fb56c', status: 'idle' },
    },
    {
      was: 'cut off with "…" (w1839): "Pick the direction … how much calibration the lab n…"',
      w: base(now, 'w1839', {
        title: 'Research: a much faster, seamless art-iteration bridge to Unity (WASM or other) for the Live view',
        brief: "Ben wants art iteration in FF Factory's Live view to be far faster and more seamless. His words:\n\n\"It's also just so slow.\"",
        requestedBy: BEN,
        requesters: [BEN],
        sessionIds: ['9a5e3b28'],
        log: [`08:18 [needs you] sent to ben's orchestrator: Pick the direction for the art-iteration bridge …`],
        needsYou: {
          key: 'declared:9a5e3b28:x',
          kind: 'declared',
          question:
            'Pick the direction for the art-iteration bridge (the research and a working browser prototype are done), and decide how the knobs keep values and how much calibration the lab needs before it is trusted.',
          who: ['Ben'],
          to: ['ben'],
          at: ago(now, 440),
          worker: '9a5e3b28',
          previews: [],
          prs: [],
        },
      }),
      live: { state: 'waiting', why: '9a5e3b28 waits on Ben: Pick the direction …', waitsOn: ['Ben'], worker: '9a5e3b28' },
      session: { id: '9a5e3b28', status: 'idle' },
    },
    {
      was: '"17e0097f stopped asking for a decision" (w1829): no decision stated, and overtaken: timed runs no longer go to m5',
      w: base(now, 'w1829', {
        title: 'Bench lock: quiet other editors and players on the machine during an exclusive timed ticket',
        brief: 'Goal: when a timed bench leg holds the exclusive ticket on a machine, the machine is actually quiet. Today the ticket only blocks new builds.',
        sessionIds: ['17e0097f'],
        log: [
          `${hhmm(sent1829)} [needs you] sent to lothsahn's orchestrator: no m5 sandbox has come free for the demo …`,
          `${hhmm(ago(now, 40))} dispatcher: queued for capacity on beast: w1829 (bench lock quieting other editors during a timed ticket): timed runs no longer go to m5, so the demo is queued for BEAST's first free seat.`,
        ],
        needsYou: {
          key: 'report:17e0097f:x',
          kind: 'report',
          question: 'No m5 sandbox has come free for the timed demo. Should I run it on BEAST instead, or keep waiting for m5?',
          who: ['Lothsahn'],
          to: ['lothsahn'],
          at: sent1829,
          worker: '17e0097f',
          previews: [],
          prs: [],
        },
      }),
      live: { state: 'waiting', why: '17e0097f stopped asking for a decision', waitsOn: ['Lothsahn'], worker: '17e0097f' },
      session: { id: '17e0097f', status: 'idle', lastResult: 'The PRs merged. No m5 sandbox has come free for the timed demo. Should I run it on BEAST instead, or keep waiting for m5?' },
    },
    {
      was: '"Waiting on input on a reviewer" (w1853): it never said what approving does',
      w: base(now, 'w1853', {
        title: 'Nightly e2e 2026-10-23: 6 regressions on master ff44324f2 (some shipped)',
        brief: 'The nightly e2e lab `lothdesktop` ran the battery on 2026-10-23 against master `ff44324f284d39943d1fbd38908068ed84a4eb01`.',
        requestedBy: BEN,
        requesters: [BEN],
        humanAsked: false,
        status: 'new',
        createdAt: ago(now, 300),
        source: {
          kind: 'nightly',
          untrusted: false,
          nightly: { scenarios: ['BAL-mid-trailer', 'MP-slow-client-catchup', 'A', 'B', 'C', 'D'], date: '2026-10-23', lab: 'lothdesktop', sha: 'ff44324f284d39943d1fbd38908068ed84a4eb01', nights: [], release: { shipped: 'yes', version: '1.0.0.10' } },
        },
        triage: { class: 'regression', reason: 'a nightly regression on master' },
        approval: { state: 'pending', why: 'auto-approve is off' },
      }),
      live: { state: 'waiting', why: 'an intake request waiting for a reviewer to approve or decline it', waitsOn: ['a reviewer'] },
    },
    {
      was: '"Waiting on input on a reviewer" (w1842): it never said what approving does',
      w: base(now, 'w1842', {
        title: 'Review and merge ffbox/circular-placement-log-once-d1210t1-c51ef713',
        brief: 'FFBox finished a diagnosis of a player report and pushed `ffbox/circular-placement-log-once-d1210t1-c51ef713`. Nobody has reviewed it.',
        requestedBy: BEN,
        requesters: [BEN],
        humanAsked: false,
        status: 'new',
        createdAt: ago(now, 450),
        source: { kind: 'ffbox-diagnosis', untrusted: true, channel: 'FFBox', conversation: '1210', branch: 'ffbox/circular-placement-log-once-d1210t1-c51ef713', version: '1.0.0.9', platform: 'OSXPlayer', rootCause: 'found' },
        triage: { class: 'needs-human', reason: 'needs a human: FFBox work that started from players’ reports or text; a person decides before anyone reviews or merges it' },
        approval: { state: 'pending', why: 'needs a human' },
      }),
      live: { state: 'waiting', why: 'an intake request waiting for a reviewer to approve or decline it', waitsOn: ['a reviewer'] },
    },
    {
      was: 'cut off with "…" (w1820): a report line longer than the 160 characters the ledger kept',
      w: base(now, 'w1820', {
        title: 'JustPlay1003: find what keeps 715 guard spawners and ~840 enemy ships awake, and tighten the wake rule if it’s waste',
        brief: 'lothsahn asked: "Why are so many enemies awake after on JustPlay1003? It\'s way more than the other saves". He chose: "Yes: find what keeps them awake and tighten the wake rule if it\'s waste".',
        sessionIds: ['9888f324'],
        log: [`15:20 [needs you] sent to lothsahn's orchestrator: w1820: still open: waiting on Lothsahn …`],
        needsYou: {
          key: 'report:9888f324:x',
          kind: 'report',
          question:
            'w1820: still open: waiting on Lothsahn to say whether PR #2268 merges now, on the census alone (stations and parked ships keep 690 of the 715 spawners awake), or after w1785’s LothDesktop timing shows what it saves per frame',
          who: ['Lothsahn'],
          to: ['lothsahn'],
          at: ago(now, 25),
          worker: '9888f324',
          previews: [],
          prs: ['Final-Factory/FinalFactory#2268'],
        },
      }),
      live: { state: 'waiting', why: "9888f324's report says a person must act: \"w1820: still open: waiting on Lothsahn to say whether PR #2268 merges now, on the census alone (stations and parked ships keep 690 of the 715 spawne…\"", waitsOn: ['Lothsahn'], worker: '9888f324' },
      session: { id: '9888f324', status: 'idle' },
    },
    {
      was: 'two questions on one request (w1821): once the frame look was answered, the Station strip question was refused twice and had no card',
      w: base(now, 'w1821', {
        title: 'UI: stacked windows let the back window’s text show through, and at 1280x800 Station Grid covers the Hide button',
        brief: 'PR #2255 lets game windows stack on top of each other again. The UI review of that PR found three problems that also happen on master.',
        sessionIds: ['1db3f09b'],
        notes: [{ at: ago(now, 10), by: 'Lothsahn', text: 'Frame look, lothsahn’s answer verbatim: "Keep frames see-through over space, solid only over a window".' }],
        log: [`${hhmm(ago(now, 60))} [needs you] sent to lothsahn's orchestrator: two questions: the frame look and the Station strip`],
        needsYou: {
          key: 'declared:1db3f09b:x',
          kind: 'declared',
          question: 'Pick the frame look and what comes up over a covered Station strip.',
          who: ['Lothsahn'],
          to: ['lothsahn'],
          at: ago(now, 60),
          raisedAt: ago(now, 60),
          worker: '1db3f09b',
          previews: [],
          prs: [],
          asks: [FRAME_ASK, STRIP_ASK],
          answeredAsks: [0],
          about: 'Stacked game windows let the back window’s text show through, and at 1280x800 the Station Grid covers the strip’s Hide button.',
          after: 'I build the picked frame look and strip change in a player and bring you their clips before anything merges.',
        },
      }),
      live: { state: 'waiting', why: '1db3f09b waits on Lothsahn: Pick the frame look and what comes up over a covered Station strip.', waitsOn: ['Lothsahn'], worker: '1db3f09b' },
      session: { id: '1db3f09b', status: 'idle' },
    },
  ];
}

/**
 * lothsahn's orchestrator's open ask_person questions (w1868, "You asked me a bunch of questions that weren't showing as
 * pending intake questions on the portal"): three about three requests, and two about one.
 */
export function orchestratorQuestions(now: number): OpenAsk[] {
  const q = (seq: number, min: number, question: string, request: string, labels: [string, string]): OpenAsk => ({
    seq,
    at: ago(now, min),
    request,
    ask: { question, options: [{ label: labels[0], description: 'What it does, in a line.', recommended: true }, { label: labels[1], description: 'The other way.' }] },
  });
  return [
    q(101, 50, 'Run the w1829 demo on BEAST now, while LothDesktop stays held for w1785?', 'w1829', ['Run the w1829 demo on BEAST now', 'Wait for LothDesktop']),
    q(102, 45, 'Merge PR #2268 on the census alone, before w1785’s timing is in?', 'w1820', ['Merge it on the census alone', 'Wait for the timing']),
    q(103, 40, 'Approve the six nightly regressions of 2026-10-23 as one request?', 'w1853', ['Approve them as one request', 'Split them by scenario']),
    q(104, 30, 'Should the Disable Transit brake take 1.5 seconds?', 'w1797', ['Yes, 1.5 seconds is right', 'Make it shorter']),
    q(105, 20, 'Should the brake ease out at the end, or stop at a constant rate?', 'w1797', ['Ease out at the end', 'Constant rate to the stop']),
  ];
}
