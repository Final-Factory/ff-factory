import { useEffect, useState } from 'react';
import { ApiError, api, type DeviceInfo, type DevicesView } from '../api';
import { toast, toastError } from '../store';
import { fmtRelative } from '../util';

const OUTCOME: Record<DevicesView['log'][number]['outcome'], string> = {
  'would-need-approval': 'would need approval',
  'would-be-refused': 'would be refused',
};

const MODE: Record<DevicesView['ownerDeviceApproval'], string> = {
  off: 'Off: an owner signs in with the password alone, from anywhere.',
  advisory:
    'Advisory: an owner who signs in from a new browser outside the tailnet is let in, and the login is listed below as one that would need approval. Nothing holds an owner yet. Approve the browsers you know, so the list shows only the ones that would really be locked out.',
};

/**
 * The owners' Devices list (w5524, docs/identity.md "Owner device approval"): every browser approved, waiting or refused
 * for a login, with Revoke, Approve and Deny, and the owner logins advisory mode let in that would need approval, so the
 * owners can see over time who enforcement would lock out before it is built. Members never see it (the route answers 403).
 */
export function DeviceSettings() {
  const [view, setView] = useState<DevicesView | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    api
      .devices()
      .then(setView)
      .catch((e) => {
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) setView(null);
        else toastError(e);
      });
  }, []);
  if (!view) return null;
  const decide = async (d: DeviceInfo, action: 'approve' | 'deny' | 'revoke') => {
    if (action === 'revoke' && d.id === view.current && !window.confirm('Revoke this browser? It signs you out here.')) return;
    setBusy(d.id);
    try {
      const r = await api.decideDevice(d.id, action);
      setView({ ...view, devices: r.devices });
      toast(`${action === 'approve' ? 'Approved' : action === 'deny' ? 'Denied' : 'Revoked'}: ${d.displayName} on ${d.label}`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const now = Date.now();
  const order = { pending: 0, approved: 1, denied: 2 } as const;
  const devices = [...view.devices].sort((a, b) => order[a.status] - order[b.status] || a.displayName.localeCompare(b.displayName));
  return (
    <div className="field devices" data-testid="devices">
      <span>Devices</span>
      <p className="small dim" data-testid="owner-device-approval">
        {MODE[view.ownerDeviceApproval]} An owner changes it with set_app_config <span className="mono">ownerDeviceApproval</span> (docs/identity.md).
      </p>
      {devices.length ? (
        <ul className="vault-list">
          {devices.map((d) => (
            <li key={d.id} className={`vault-row${d.status === 'denied' ? ' dim' : ''}`} data-device-row={d.id}>
              <div title={d.userAgent}>
                <b>{d.displayName}</b> {d.label}
                {d.id === view.current ? <span className="tone-green"> (this browser)</span> : null}{' '}
                <span className="dim small">
                  {d.status === 'approved' ? `approved${d.decidedBy ? ` by ${d.decidedBy}` : ''}` : d.status === 'pending' ? (d.advisory ? 'new, let in (advisory)' : 'waiting for approval') : 'refused'} · from {d.ip} · seen {fmtRelative(d.lastSeenAt ?? d.createdAt, now)}
                </span>
              </div>
              <div className="field-row">
                {d.status !== 'approved' && (
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy === d.id} onClick={() => void decide(d, 'approve')}>
                    Approve
                  </button>
                )}
                {d.status === 'pending' && (
                  <button type="button" className="btn btn-sm" disabled={busy === d.id} onClick={() => void decide(d, 'deny')}>
                    Deny
                  </button>
                )}
                <button type="button" className="btn btn-sm btn-ghost danger-hover" disabled={busy === d.id} onClick={() => void decide(d, 'revoke')} title="Forget this browser and end its sessions">
                  {d.status === 'approved' ? 'Revoke' : 'Forget'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small dim">No devices yet.</p>
      )}
      <details data-testid="device-log">
        <summary className="small">
          Would have needed approval: {view.log.length} login{view.log.length === 1 ? '' : 's'} in the last 180 days
        </summary>
        {view.log.length ? (
          <ul className="vault-list">
            {view.log.map((e) => (
              <li key={`${e.at}-${e.device}`} className="vault-row small" title={e.userAgent}>
                {fmtRelative(e.at, now)}: <b>{e.displayName}</b> on {e.label} from {e.ip}, {OUTCOME[e.outcome]}
                {e.mode === 'advisory' ? ' (advisory, let in)' : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small dim">None: nobody would have been locked out.</p>
        )}
      </details>
    </div>
  );
}
