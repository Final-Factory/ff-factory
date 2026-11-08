// w3730: a Stop button on each bench ticket a person may stop (lothsahn, 2026-11-08, about bench locks: "Make sure that this
// situation can never happen again… get it fixed"; the design asked for a Stop button for each lock on the dashboard). It
// asks first, then the portal sends the daemon's bench_revoke in this person's name (server/benchStop.ts). Which tickets
// get one is shared/benchStop.ts's rule, the server's too: never an editor's, a timed run's, the release lane's or the
// nightly's.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { benchStopRefusal } from '../../../shared/benchStop';
import type { BenchState, BenchTicketGlance } from '../../../shared/types';
import { api } from '../api';
import { attempt, toast } from '../store';
import { Confirm } from './ui';

const who = (t: BenchTicketGlance) => (t.requests?.length ? t.requests.join(', ') : t.ticket);

/** The Stop buttons for `bench`'s running tickets on `machineId`; `exclusiveOnly` for the board card, which shows the lock. */
export function BenchStopButtons({ machineId, bench, exclusiveOnly }: { machineId?: string; bench?: BenchState; exclusiveOnly?: boolean }) {
  const [ask, setAsk] = useState<BenchTicketGlance>();
  const tickets = machineId ? (bench?.running ?? []).filter((t) => !benchStopRefusal(t) && (!exclusiveOnly || t.mode === 'exclusive')) : [];
  if (!machineId || (!tickets.length && !ask)) return null;
  return (
    <span className="bench-stops" data-testid="bench-stops">
      {tickets.map((t) => (
        <button
          key={t.ticket}
          className="btn btn-ghost btn-xs"
          data-testid="bench-stop"
          data-ticket={t.ticket}
          title={`Stop ${t.mode} bench ticket ${t.ticket} (${who(t)}, worker ${t.session?.slice(0, 8)}): "${t.what}"`}
          onClick={(e) => {
            e.stopPropagation();
            setAsk(t);
          }}
        >
          Stop {who(t)}
        </button>
      ))}
      {ask &&
        createPortal(
          <Confirm
            title={`Stop ${machineId}'s bench ticket ${ask.ticket}?`}
            danger
            confirmLabel="Stop ticket"
            body={
              <>
                <p>
                  {ask.mode === 'exclusive' ? 'Exclusive' : 'Shared'} ticket {ask.ticket} for {who(ask)} (worker {ask.session?.slice(0, 8)}
                  ): "{ask.what}".
                </p>
                <p>What runs under it is asked to stop now, and its helper is ended 90 seconds later if it still holds. Samples already written are kept. Its worker is told you stopped it.</p>
              </>
            }
            onConfirm={async () => {
              const r = await attempt(api.stopBenchTicket(machineId, ask.ticket));
              if (r) toast(r.note);
            }}
            onClose={() => setAsk(undefined)}
          />,
          document.body,
        )}
    </span>
  );
}
