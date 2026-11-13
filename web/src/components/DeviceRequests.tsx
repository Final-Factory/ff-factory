import { useEffect, useState } from 'react';
import type { AppState } from '../../../shared/types';
import { api, type DeviceInfo } from '../api';
import { toast } from '../store';
import { fmtRelative } from '../util';

/**
 * Device approval (docs/identity.md): a member's login from a browser no owner approved for them waits. The owners see one
 * bar per waiting browser, above every page, and approve or deny it here. Polled: every 20 seconds while approval is on,
 * every 5 minutes while it is off (an owner may turn it on meanwhile).
 */
export function DeviceRequests({ app }: { app: AppState }) {
  const owner = app.me?.role === 'owner';
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!owner) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let next = 5 * 60_000;
      try {
        if (document.visibilityState !== 'hidden') {
          const r = await api.devices();
          if (stop) return;
          setDevices(r.devices);
          setOn(r.deviceApproval === 'members');
          if (r.deviceApproval === 'members' || r.devices.some((d) => d.status === 'pending')) next = 20_000;
        } else next = 20_000;
      } catch {
        next = 60_000;
      }
      if (!stop) t = setTimeout(poll, next);
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [owner]);

  if (!owner) return null;
  const pending = devices.filter((d) => d.status === 'pending');
  if (!pending.length) return null;
  const decide = async (d: DeviceInfo, action: 'approve' | 'deny') => {
    setBusy(d.id);
    try {
      const r = await api.decideDevice(d.id, action);
      setDevices(r.devices);
      toast(`${action === 'approve' ? 'Approved' : 'Denied'}: ${d.displayName} on ${d.label}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {pending.map((d) => {
        const text = `${d.displayName} asks to sign in from a new device: ${d.label}, from ${d.ip}, ${fmtRelative(d.lastSeenAt ?? d.createdAt, Date.now())}.${on ? '' : ' (Device approval is off now.)'}`;
        return (
          <div key={d.id} className="gbar gbar-warn" role="status" data-device={d.id}>
            <span className="gbar-text" title={`${text}\n${d.userAgent}`}>
              <b>{d.displayName} asks to sign in from a new device:</b> {d.label}, from {d.ip}, {fmtRelative(d.lastSeenAt ?? d.createdAt, Date.now())}.
            </span>
            <button type="button" className="btn btn-sm btn-primary gbar-x" disabled={busy === d.id} onClick={() => void decide(d, 'approve')}>
              Approve
            </button>
            <button type="button" className="btn btn-sm gbar-x" disabled={busy === d.id} onClick={() => void decide(d, 'deny')}>
              Deny
            </button>
          </div>
        );
      })}
    </>
  );
}
