// How a Dispatcher pane row names where a request came from (docs/intake.md), shared so the server tests cover it.
import type { WorkSource } from './types.ts';

/** "Discord bug", "Discord request", "FFBox branch", "lothsahn (FFBox)", …: where an intake request came from. */
export function sourceLabel(s: WorkSource): string {
  switch (s.kind) {
    case 'discord-bug':
      return 'Discord bug';
    case 'discord-request':
      return `Discord request${s.reporter ? ` from ${s.reporter}` : ''}`;
    case 'ffbox-branch':
      return 'FFBox branch';
    case 'ffbox-diagnosis':
      return 'FFBox diagnosis';
    case 'ffbox-request':
      return 'FFBox request';
    case 'ffbox-dev':
      // w1105: the operator and where it came from, short ("lothsahn (FFBox)"), for every operator.
      return s.reporter ? `${s.reporter} (FFBox)` : 'FFBox dev request';
    case 'release':
      return 'Release follow-up';
    case 'nightly':
      return `Nightly regression${s.nightly?.date ? ` ${s.nightly.date}` : ''}`;
    case 'nightly-run':
      return `Nightly run${s.nightlyRun?.date ? ` ${s.nightlyRun.date}` : ''}`;
    case 'nightly-review':
      return `Nightly merge review${s.nightlyReview?.date ? ` ${s.nightlyReview.date}` : ''}`;
    case 'master-batch':
      return `Master batch red${s.masterBatch?.pr ? ` (#${s.masterBatch.pr})` : ''}`;
  }
}

/** The untrusted marking of a request's source, in the detail: short for an FFBox dev request (w1105), else as before. */
export const untrustedLabel = (s: Pick<WorkSource, 'kind'>) => (s.kind === 'ffbox-dev' ? 'untrusted' : 'players’ text, untrusted');

/**
 * Whether the detail's facts line still says who reported a request and who it is for (w1105): an FFBox dev request names its
 * operator in the label already, so "reported by" repeats it, and "for <person>" repeats it too when it is the same name.
 */
export function namesReporter(s: Pick<WorkSource, 'kind' | 'reporter'>): boolean {
  return !!s.reporter && s.kind !== 'ffbox-dev';
}
export function namesRequesters(s: Pick<WorkSource, 'kind' | 'reporter'>, requesters: string): boolean {
  return !(s.kind === 'ffbox-dev' && !!s.reporter && s.reporter.trim().toLowerCase() === requesters.trim().toLowerCase());
}
