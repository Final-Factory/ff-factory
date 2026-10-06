import { useEffect, useRef, useState } from 'react';
import { attempt } from '../store';
import { Icon } from './ui';

/** A sandbox editor's log, followed (a machine sandbox's page; MachineSandboxPanel). */
export function UnityLogDrawer({ name, logPath, load: fetchLines, onClose }: { name: string; logPath?: string; load: (lines: number) => Promise<{ lines: string[] }>; onClose: () => void }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [follow, setFollow] = useState(true);
  const [loading, setLoading] = useState(false);
  const pre = useRef<HTMLPreElement>(null);

  const load = async () => {
    setLoading(true);
    const r = await attempt(fetchLines(400));
    setLoading(false);
    if (r) setLines(r.lines);
  };

  useEffect(() => {
    void load();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [name]);

  useEffect(() => {
    if (!follow) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [follow, name]);

  useEffect(() => {
    if (follow && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [lines, follow]);

  return (
    <div className="overlay overlay-drawer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-modal>
        <header className="drawer-head">
          <Icon name="log" />
          <span className="ellipsis">
            Unity log · <span className="accent">{name}</span>
          </span>
          {logPath && (
            <span className="mono dim small ellipsis hide-sm" title={logPath}>
              {logPath}
            </span>
          )}
          <div className="spacer" />
          <label className="check check-inline">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
          </label>
          <button className="btn btn-ghost btn-icon" onClick={load} title="Refresh" aria-label="Refresh">
            {loading ? <span className="spinner" /> : <Icon name="refresh" />}
          </button>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <pre className="log" ref={pre}>
          {lines === null
            ? 'Loading…'
            : lines.length === 0
              ? 'Log is empty.'
              : lines.map((l, i) => (
                  <div key={i} className={/error|exception|CS\d{4}/i.test(l) ? 'log-err' : /warning/i.test(l) ? 'log-warn' : undefined}>
                    {l}
                  </div>
                ))}
        </pre>
      </div>
    </div>
  );
}
