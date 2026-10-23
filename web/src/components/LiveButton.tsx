import { useStore } from '../store';
import { navigate, useRoute } from '../util';
import { Dot } from './ui';

/**
 * "Live view": opens the session's view of the game beside its conversation (docs/live-view.md). Shown while the session has one.
 * The green mark only while it streams (w1838); otherwise a grey dot, and its title says it is not streaming.
 */
export function LiveButton({ sessionId }: { sessionId: string }) {
  const route = useRoute();
  const state = useStore((s) => (s.app?.config.live?.enabled ? s.app.live?.find((v) => v.sessionId === sessionId)?.state : undefined));
  if (!state || route.view === 'live') return null;
  const live = state === 'live';
  return (
    <button
      type="button"
      className="btn btn-outline btn-xs lv-open"
      title={live ? 'Watch the game beside this conversation and move the asset\'s knobs' : 'Its Live view is up but not streaming now: open it to see what it waits on'}
      data-testid="live-open"
      onClick={() => navigate({ view: 'live', sessionId })}
    >
      {live ? <span className="lv-rec" /> : <Dot tone="grey" />} Live view
    </button>
  );
}
