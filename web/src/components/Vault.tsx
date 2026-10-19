import { useEffect, useState } from 'react';
import type { GithubAppHealth, GithubTokenHealth, VaultEntryMeta, VaultKind, VaultRole, VaultShare, VaultView } from '../../../shared/types';
import { ApiError, api } from '../api';
import { toast, toastError } from '../store';

/**
 * The token vault (docs/vault.md, w512), in the settings dialog: an owner's only (anyone else gets a 403 and sees nothing).
 * A value is typed into a password field, sent once and never shown back: the list shows each entry's fingerprint and
 * last four characters.
 */
export function VaultSettings() {
  const [view, setView] = useState<VaultView | null | undefined>(undefined);
  useEffect(() => {
    api
      .vault()
      .then(setView)
      .catch((e) => {
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) setView(null);
        else toastError(e);
      });
  }, []);
  if (!view) return null;
  const act = async (p: Promise<VaultView>, done: string) => {
    try {
      setView(await p);
      toast(done);
    } catch (e) {
      toastError(e);
    }
  };
  const s = view.status;
  return (
    <div className="field vault" data-testid="vault">
      <span>Token vault</span>
      <p className="small dim">
        The secrets worker runs get from the portal (docs/vault.md): Claude tokens, picked per run by plan headroom on machines set to take them, and the other
        tokens granted to a machine. Values are never shown back. On the VM, <span className="mono">sudo fffctl vault</span> does the same.
      </p>
      <p className={`small ${s.key === 'loaded' ? 'tone-green' : 'tone-amber'}`} data-testid="vault-key">
        Key {s.key}
        {s.why ? `: ${s.why}` : ''}
      </p>
      {view.entries.length ? (
        <ul className="vault-list">
          {view.entries.map((e) => (
            <VaultRow key={e.id} e={e} people={view.people} github={view.github?.find((g) => g.fingerprint === e.fingerprint)} app={view.githubApps?.find((g) => g.name === e.name)} onChange={act} />
          ))}
        </ul>
      ) : (
        <p className="small dim">No entries yet.</p>
      )}
      <AddEntry view={view} onChange={act} />
      <p className="small dim">
        Every Claude process runs on a token from the vault: the portal's orchestrators, the dispatcher and the orchestration worker, and every machine's runs{view.machines.length ? ` (${view.machines.map((m) => m.id).join(', ')})` : ''}.{' '}
        <small>A person with no usable token waits; nothing falls back to another credential.</small>
      </p>
      <p className="small dim" data-testid="vault-github-on">
        GitHub tokens from the vault on: {[...(view.githubPortal ? ['the portal\'s own reads'] : []), ...view.machines.filter((m) => m.githubFromVault).map((m) => m.id)].join(', ') || 'nowhere yet: every caller uses its own gh login'}{' '}
        <small>(set_app_config machines.githubFromVault, per machine; machine "portal" for the portal's reads; docs/vault.md section 13)</small>
      </p>
      {view.github?.filter((h) => h.portal).map((h) => (
        <GithubHealth key={h.fingerprint} h={h} name="portal-login" />
      ))}
      <p className="small dim">
        Every GitHub token is checked against the required repositories and permissions (docs/vault.md 13.2) every 6 hours.{' '}
        <button
          className="btn btn-ghost btn-sm"
          data-testid="vault-github-recheck"
          onClick={async () => {
            try {
              const r = await api.githubRecheck();
              setView(await api.vault());
              toast(r.ran ? 'GitHub tokens checked again' : 'Checked less than 30 seconds ago; try again shortly');
            } catch (e) {
              toastError(e);
            }
          }}
        >
          Re-check now
        </button>
      </p>
      <MachineCredentials view={view} onChange={act} />
    </div>
  );
}

type Act = (p: Promise<VaultView>, done: string) => Promise<void>;
const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

function VaultRow({ e, people, github, app, onChange }: { e: VaultEntryMeta; people: VaultView['people']; github?: GithubTokenHealth; app?: GithubAppHealth; onChange: Act }) {
  const [rotating, setRotating] = useState(false);
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [machines, setMachines] = useState(e.machines.join(', '));
  const [roles, setRoles] = useState(e.roles.join(', '));
  const [email, setEmail] = useState(e.email ?? '');
  const [sure, setSure] = useState(false);
  const owner = people.find((p) => p.userId.toLowerCase() === e.owner?.toLowerCase())?.displayName ?? e.owner;
  return (
    <li className={`vault-row${e.disabled ? ' dim' : ''}`} data-testid={`vault-${e.name}`}>
      <div>
        <b>{e.name}</b> <span className="dim">{e.kind === 'env' ? e.env : e.kind}</span> <span className="mono">…{e.last4}</span>{' '}
        <span className="mono dim" title="the first 12 hex characters of its SHA-256">
          {e.fingerprint}
        </span>
        {e.kind === 'claude' && (
          <>
            {' '}
            <span className="small dim" data-testid={`vault-email-${e.name}`} title="the Claude account email a person recorded for this token; the token itself does not tell">
              {e.email ?? 'email not recorded'}
            </span>
          </>
        )}
      </div>
      <div className="small dim">
        {e.share === 'owner' ? `${owner}'s own work only` : `any run${owner ? ` (${owner}'s)` : ''}`}; {e.roles.join(', ')} on {e.machines.join(', ')}
        {e.disabled ? '; disabled' : ''}; {e.rotatedAt ? `rotated ${e.rotatedAt.slice(0, 10)}` : `added ${e.createdAt.slice(0, 10)}`}
      </div>
      {e.kind === 'github' && <GithubHealth h={github} name={e.name} />}
      {e.kind === 'github-app' && <GithubAppLine h={app} e={e} />}
      {rotating && (
        <div className="field-row">
          <input className="input" type="password" autoComplete="off" placeholder="the new value" value={value} onChange={(x) => setValue(x.target.value)} />
          <button
            className="btn btn-primary"
            disabled={!value.trim()}
            onClick={async () => {
              await onChange(api.vaultRotate(e.name, value.trim()), `rotated ${e.name}`);
              setValue('');
              setRotating(false);
            }}
          >
            Save
          </button>
        </div>
      )}
      {editing && (
        <div className="field-row">
          <input className="input" aria-label="machines" placeholder="machines: m3, m5 or *" value={machines} onChange={(x) => setMachines(x.target.value)} />
          <input className="input" aria-label="roles" placeholder="roles: workers, standing" value={roles} onChange={(x) => setRoles(x.target.value)} />
          {e.kind === 'claude' && <input className="input" type="email" aria-label="account email" placeholder="Claude account email (optional)" value={email} onChange={(x) => setEmail(x.target.value)} />}
          <button
            className="btn btn-primary"
            onClick={async () => {
              await onChange(api.vaultUpdate(e.name, { machines: list(machines), roles: list(roles) as VaultRole[], ...(e.kind === 'claude' ? { email: email.trim() } : {}) }), `changed ${e.name}`);
              setEditing(false);
            }}
          >
            Save
          </button>
        </div>
      )}
      <div className="vault-actions">
        <button className="btn btn-ghost btn-sm" onClick={() => setRotating((r) => !r)}>
          Rotate
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setEditing((r) => !r)}>
          Grant
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => void onChange(api.vaultUpdate(e.name, { disabled: !e.disabled }), `${e.disabled ? 'enabled' : 'disabled'} ${e.name}`)}>
          {e.disabled ? 'Enable' : 'Disable'}
        </button>
        <button className="btn btn-ghost btn-sm danger-hover" onClick={() => (sure ? void onChange(api.vaultRemove(e.name), `removed ${e.name}`) : setSure(true))}>
          {sure ? 'Really remove?' : 'Remove'}
        </button>
      </div>
    </li>
  );
}

function AddEntry({ view, onChange }: { view: VaultView; onChange: Act }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<VaultKind>('claude');
  const [env, setEnv] = useState('');
  const [owner, setOwner] = useState('');
  const [share, setShare] = useState<VaultShare>('owner');
  const [roles, setRoles] = useState('workers, standing');
  const [machines, setMachines] = useState('*');
  const [email, setEmail] = useState('');
  const [appId, setAppId] = useState('');
  const [appOwners, setAppOwners] = useState('');
  const [value, setValue] = useState('');
  if (!open)
    return (
      <button className="btn btn-outline btn-sm" onClick={() => setOpen(true)}>
        Add a token
      </button>
    );
  return (
    <div className="vault-add">
      <div className="field-row">
        <input className="input" aria-label="name" placeholder="name, e.g. ben-max" value={name} onChange={(x) => setName(x.target.value)} />
        <select className="input" aria-label="kind" value={kind} onChange={(x) => setKind(x.target.value as VaultKind)}>
          {view.kinds.map((k) => (
            <option key={k} value={k}>
              {k === 'claude' ? 'Claude token (setup-token)' : k === 'github' ? 'GitHub token' : k === 'github-app' ? 'GitHub App (private key)' : 'another secret (env)'}
            </option>
          ))}
        </select>
        {kind === 'env' && <input className="input" aria-label="variable" placeholder="FFDISCORD_APP_TOKEN" value={env} onChange={(x) => setEnv(x.target.value)} />}
      </div>
      <div className="field-row">
        <select className="input" aria-label="owner" value={owner} onChange={(x) => setOwner(x.target.value)}>
          <option value="">no owner</option>
          {view.people.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.displayName}
            </option>
          ))}
        </select>
        <select className="input" aria-label="share" value={share} onChange={(x) => setShare(x.target.value as VaultShare)}>
          <option value="owner">the owner's own work only</option>
          <option value="anyone">any run</option>
        </select>
      </div>
      <div className="field-row">
        <input className="input" aria-label="roles" placeholder="roles: workers, standing" value={roles} onChange={(x) => setRoles(x.target.value)} />
        <input className="input" aria-label="machines" placeholder="machines: m3, m5 or *" value={machines} onChange={(x) => setMachines(x.target.value)} />
      </div>
      {kind === 'github-app' && (
        <div className="field-row">
          <input className="input" aria-label="app id" placeholder="App ID (General settings of the app)" value={appId} onChange={(x) => setAppId(x.target.value)} />
          <input className="input" aria-label="app owners" placeholder="accounts whose installations are used: Gherik1" value={appOwners} onChange={(x) => setAppOwners(x.target.value)} />
        </div>
      )}
      {kind === 'claude' && (
        <div className="field-row">
          <input className="input" type="email" aria-label="account email" placeholder="the Claude account's email (optional; shown on the accounts list)" value={email} onChange={(x) => setEmail(x.target.value)} />
        </div>
      )}
      <div className="field-row">
        <input className="input" type="password" autoComplete="off" aria-label="value" placeholder={kind === 'github-app' ? "the .pem file's whole text (never shown again)" : 'the token (never shown again)'} value={value} onChange={(x) => setValue(x.target.value)} />
        <button
          className="btn btn-primary"
          disabled={!name.trim() || !value.trim()}
          onClick={async () => {
            await onChange(
              api.vaultAdd({ name: name.trim(), kind, env: env.trim() || undefined, owner: owner || undefined, email: kind === 'claude' ? email.trim() || undefined : undefined, share, roles: list(roles) as VaultRole[], machines: list(machines), value: value.trim(), ...(kind === 'github-app' ? { appId: appId.trim(), appOwners: list(appOwners) } : {}) }),
              `added ${name.trim()}`,
            );
            setValue('');
            setEmail('');
            setOpen(false);
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function MachineCredentials({ view, onChange }: { view: VaultView; onChange: Act }) {
  const [sure, setSure] = useState('');
  if (!view.enrolled.length) return null;
  return (
    <div className="small">
      <span className="dim">Machine credentials (revoke cuts a machine off now; a new one: </span>
      <span className="mono">fffctl machine-credential issue</span>
      <span className="dim">):</span>{' '}
      {view.enrolled.map((id) => (
        <button key={id} className="btn btn-ghost btn-sm danger-hover" onClick={() => (sure === id ? void onChange(api.revokeMachineCredential(id), `revoked ${id}`) : setSure(id))}>
          {sure === id ? `Really revoke ${id}?` : `${id} ✕`}
        </button>
      ))}
    </div>
  );
}

const minute = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')}Z`;

/**
 * A GitHub token's health (w868, server/githubTokens.ts): the account it acts as, its expiry, the reads it lacks per
 * repository (write permissions cannot be read without writing), its last use and its last error.
 */
/** A GitHub App's health (w1519, docs/github-apps.md): its key, each allowed installation, the ignored ones. Never a value. */
function GithubAppLine({ h, e }: { h?: GithubAppHealth; e: VaultEntryMeta }) {
  const head = `App ID ${e.appId ?? '?'}; installations of ${(e.appOwners ?? []).join(', ')}${e.uninstallOthers ? ' (uninstalls the others)' : ''}`;
  if (!h?.checkedAt) return <div className="small dim" data-testid={`vault-github-app-${e.name}`}>{head}; not read yet</div>;
  const lacking = h.problems ?? [];
  const allowed = (h.installations ?? []).filter((i) => i.allowed);
  const ignored = (h.installations ?? []).filter((i) => !i.allowed);
  return (
    <div className={`small ${lacking.length ? 'tone-amber' : 'dim'}`} data-testid={`vault-github-app-${e.name}`}>
      {head}
      {h.bad ? `; NOT USED: ${h.bad}` : `; key valid${h.slug ? ` (${h.slug})` : ''}`}
      {allowed.map((i) => `; ${i.account}: ${i.selection === 'all' ? 'every repository' : (i.repos ?? []).join(', ') || 'no repository'}${i.tokenExpiresAt ? `, token until ${minute(i.tokenExpiresAt)}` : ''}`).join('')}
      {ignored.length ? `; ignored (not on the allowlist): ${ignored.map((i) => `${i.account}${i.uninstalledAt ? ' (uninstalled)' : ''}`).join(', ')}` : ''}
      {lacking.length ? `; lacks: ${lacking.join('; ')}` : ''}; read {minute(h.checkedAt)}
      {h.lastUse ? `; last used ${minute(h.lastUse.at)} (${h.lastUse.what})` : ''}
      {h.lastError ? `; last error ${minute(h.lastError.at)}: ${h.lastError.what}` : ''}
    </div>
  );
}

function GithubHealth({ h, name }: { h?: GithubTokenHealth; name: string }) {
  if (!h?.checkedAt) return <div className="small dim" data-testid={`vault-github-${name}`}>GitHub: not probed yet{h?.lastUse ? `; last used ${minute(h.lastUse.at)} (${h.lastUse.what})` : ''}</div>;
  const days = h.expiresAt ? Math.floor((Date.parse(h.expiresAt) - Date.now()) / 86_400_000) : undefined;
  const lacking = h.problems ?? [];
  return (
    <div className={`small ${lacking.length ? 'tone-amber' : 'dim'}`} data-testid={`vault-github-${name}`}>
      GitHub {h.login ? `account ${h.login}` : 'account unknown'}
      {days === undefined ? (h.bad ? '' : '; no expiry given') : `; expires ${h.expiresAt!.slice(0, 10)} (${days} days)`}
      {lacking.length ? `; lacks: ${lacking.join('; ')}` : h.repos ? `; has every required read on ${h.repos.length} repositories` : ''}
      ; probed {minute(h.checkedAt)}
      {h.portal ? '' : h.lastUse ? `; last used ${minute(h.lastUse.at)} (${h.lastUse.what})` : '; not used since the portal started'}
      {h.lastError ? `; last error ${minute(h.lastError.at)}: ${h.lastError.what}` : ''}
    </div>
  );
}
