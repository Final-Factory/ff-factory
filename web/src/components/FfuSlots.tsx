import { ffuSummary, slotState } from '../../../shared/ffuSlots';
import type { AppState, FfuSlotsReport, FfuSlotView } from '../../../shared/types';
import { sessionIndex } from '../store';
import { fmtRelative, navigate, type Tone } from '../util';
import { Chip, Icon } from './ui';
import { DetailsSection } from './PanelChrome';

const GB = 1024 ** 3;
const TONE: Record<ReturnType<typeof slotState>, Tone> = { free: 'green', held: 'blue', stale: 'amber' };
const HOLDER: Record<NonNullable<FfuSlotView['holderIs']>, string> = { live: 'runs', stopped: 'stopped', gone: 'gone', unknown: 'not known' };

/**
 * A machine's ffu build slots (w5912, docs/ffu-sandboxes.md): a set of their own beside its game sandboxes, each with its
 * holder and request, branch and commit, since when, its target's size and whether the hold is stale, as `ffu-slot list`
 * judged them on the machine. A view only: the next `ffu-slot take` frees a stale hold by itself (w5885).
 */
export function FfuSlotsSection({ app, report, now }: { app: AppState; report: FfuSlotsReport; now: number }) {
  const byId = sessionIndex(app.sessions);
  return (
    <DetailsSection title={`ffu slots · ${ffuSummary(report)}`}>
      <ul className="ffu-slots" data-testid="ffu-slots">
        {report.slots.map((s) => {
          const st = slotState(s);
          const who = s.holder ? byId.get(s.holder) : undefined;
          return (
            <li key={s.id} className={`ffu-slot ffu-slot-${st}`} data-testid={`ffu-slot-${s.id}`}>
              <div className="ffu-slot-head">
                <Icon name="tools" size={13} />
                <span className="mono">{s.id}</span>
                <Chip tone={TONE[st]} title={st === 'stale' ? 'Held, but another worker may take it now: its holder finished, stopped or left it unused past its limit (w5885)' : undefined}>
                  {st}
                </Chip>
                {s.targetBytes !== undefined && (
                  <span className="dim small" title={s.sizedAt ? `measured by the clean-up pass ${fmtRelative(s.sizedAt, now)}` : undefined}>
                    {(s.targetBytes / GB).toFixed(1)} GB target
                  </span>
                )}
              </div>
              <div className="ffu-slot-body small">
                {s.holder ? (
                  <span className="ellipsis">
                    {who ? (
                      <button className="link-btn" onClick={() => navigate({ view: 'session', sessionId: who.id })}>
                        {who.title}
                      </button>
                    ) : (
                      <span className="mono">{s.holder}</span>
                    )}
                    <span className="dim"> · {HOLDER[s.holderIs ?? 'unknown']}{s.takenAt ? ` · since ${fmtRelative(s.takenAt, now)}` : ''}</span>
                  </span>
                ) : (
                  <span className="dim">released</span>
                )}
                <span className="dim mono ellipsis">
                  {s.branch ?? 'origin/main'}
                  {s.commit ? ` @ ${s.commit.slice(0, 8)}` : ''}
                  {s.usedAt ? ` · used ${fmtRelative(s.usedAt, now)}` : ''}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </DetailsSection>
  );
}
