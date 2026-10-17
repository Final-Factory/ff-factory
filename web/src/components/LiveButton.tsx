import { useStore } from '../store';
import { navigate, useRoute } from '../util';

/** "Live view": opens the session's view of the game beside its conversation (docs/live-view.md). Shown while the session has one. */
export function LiveButton({ sessionId }: { sessionId: string }) {
  const route = useRoute();
  const has = useStore((s) => !!s.app?.config.live?.enabled && !!s.app.live?.some((v) => v.sessionId === sessionId));
  if (!has || route.view === 'live') return null;
  return (
    <button type="button" className="btn btn-outline btn-xs lv-open" title="Watch the game beside this conversation and move the asset's knobs" data-testid="live-open" onClick={() => navigate({ view: 'live', sessionId })}>
      <span className="lv-rec" /> Live view
    </button>
  );
}
