import { useEffect, useState } from 'react';
import type { AppState } from '../../../shared/types';
import { api, type DeviceInfo } from '../api';
import { toast } from '../store';
import { fmtRelative } from '../util';
import { startDevicePoll } from '../../../shared/devicePoll';

/**
 * Device approval (docs/identity.md): a member's login from a browser no owner approved for them waits. The owners see one
 * bar per waiting browser, above every page, and approve or deny it here. Polled: every 20 seconds while approval is on,
 * every 5 minutes while it is off (an owner may turn it on meanwhile), and at once when the tab comes back into view (w10).
 */
export function DeviceRequests({ app }: { app: AppState }) {
  const owner = app.me?.role === 'owner';
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!owner) return;
    let stop = false;
    const end = startDevicePoll(
      async () => {
        const r = await api.devices();
        if (stop) return 5 * 60_000;
        setDevices(r.devices);
        setOn(r.deviceApproval === 'members');
        return r.deviceApproval === 'members' || r.devices.some((d) => d.status === 'pending') ? 20_000 : 5 * 60_000;
      },
      document,
      window,
    );
    return () => {
      stop = true;
      end();
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
