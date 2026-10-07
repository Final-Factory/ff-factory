// What an intake request's decision currently is, in the words the Intake tab, the Requests tab and list_work share
// (w319, asked by Lothsahn): "needs a human" only while it waits for a person; after that it says who decided and when,
// or how it closed. The triage verdict from filing is history, not state.
import type { WorkItem } from './types.ts';

export type DecisionState = 'waiting' | 'approved' | 'auto-approved' | 'declined' | 'closed';

export interface Decision {
  state: DecisionState;
  /** "needs a human", "approved by Ben 2026-10-03 20:51 UTC", "declined by Ben …", "closed: merged as #946 (…) on …". */
  text: string;
}

/** "2026-10-03 20:51 UTC". */
export const utcStamp = (iso: string | undefined) => (iso ? ` ${iso.slice(0, 16).replace('T', ' ')} UTC` : '');

type Subject = Pick<WorkItem, 'status' | 'approval' | 'triage' | 'autoClosed'>;

/**
 * The current decision on an intake request, or undefined when there is nothing to say (a person's own request, or one
 * that closed some other way without ever being approved).
 */
export function decisionOf(w: Subject): Decision | undefined {
  if (w.autoClosed) return { state: 'closed', text: `closed: ${w.autoClosed.text}` };
  const a = w.approval;
  if (!a) return undefined;
  if (a.state === 'declined') return { state: 'declined', text: `declined by ${a.by && a.by !== 'auto' ? a.by.displayName : 'a reviewer'}${utcStamp(a.at)}` };
  if (a.state === 'approved') {
    return a.by === 'auto' ? { state: 'auto-approved', text: `auto-approved${utcStamp(a.at)}` } : { state: 'approved', text: `approved by ${a.by ? a.by.displayName : 'a reviewer'}${utcStamp(a.at)}` };
  }
  if (w.status !== 'new' && w.status !== 'question' && w.status !== 'queued' && w.status !== 'blocked' && w.status !== 'active') return undefined;
  return { state: 'waiting', text: w.triage?.class === 'needs-human' ? 'needs a human' : 'awaiting approval' };
}
