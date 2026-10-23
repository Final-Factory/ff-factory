import { useEffect, useState } from 'react';
import { benchGlance } from '../../../shared/benchGlance';
import { machineKind, type AppState, type Machine } from '../../../shared/types';
import { api, type JoinAnswer } from '../api';
import { attempt, sessionsByIds, toast, upsertMachine } from '../store';
import { displayName, fmtRelative, isUnused, machineGlance, machineLabel, machineTone, navigate, useNow } from '../util';
import { GitFacts } from './Git';
import { DetailsSection, DetailsSheet, PanelHeader, useDetailsOpen } from './PanelChrome';
import { Chip, Confirm, CopyButton, Icon, Modal, StateText } from './ui';

const midTurn = (status: string) => status === 'running' || status === 'starting' || status === 'waiting_permission';

/**
 * A machine's agent cap, as server/machines.ts agentCap counts it (w536): its sandboxes' and its standing agents
 * mid-turn together, max_sandbox_agents or every sandbox full; 2 standing agents on a machine without sandboxes.
 */
const agentCap = (m: Machine) => (m.sandboxRoot ? (m.maxSandboxAgents ?? (m.maxSandboxes ?? 3) * (m.maxAgentsPerSandbox ?? 2)) : 2);

/**
 * One of the user's Macs or Windows PCs (docs/machines.md): its daemon's state, its clone and its sandboxes. Its
 * workers are in its sandboxes, each with its own page (w536: none in the main clone); standing agents have theirs.
 */
export function MachinePanel({ app, machine: m, onClose }: { app: AppState; machine: Machine; onClose?: () => void }) {
  const now = useNow();
  const here = sessionsByIds(app.sessions, m.sessionIds);
  const [label, setLabel] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmRedeploy, setConfirmRedeploy] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  // A redeploy or daemon restart stops every agent there, its sandboxes' too.
  const live = here.filter((s) => s.kind !== 'standing' && midTurn(s.status)).length;
  // What its agent cap counts: sandbox and standing agents mid-turn.
  const running = here.filter((s) => midTurn(s.status)).length;
  const g = m.git;

  const redeploy = async () => {
    const r = await attempt(api.redeployMachine(m.id, live > 0));
    if (r) upsertMachine(r);
  };
  // A daemon stopped on purpose is started; otherwise restarted (its agents stop, so asked first when any run).
  const daemonAction = m.daemonStopped ? 'start' : 'restart';
  const controlDaemon = async () => {
    const r = await attempt(api.machineDaemon(m.id, daemonAction, live > 0));
    if (r) toast(r.note);
  };

  const [details, setDetails] = useDetailsOpen('machine');
  const glance = machineGlance(m, here, now);
  // Its bench queue (w1835): Exclusive, Shared or Free, as its daemon's last stats said.
  const bench = m.online ? benchGlance(app.machineStats?.[m.id]?.bench, now) : undefined;

  return (
    <section className="sb-panel">
      <PanelHeader
        onBack={onClose}
        title={displayName(m)}
        titleClass={isUnused(m.purpose) ? 'is-unused' : ''}
        state={<StateText tone={glance.tone} label={glance.label} pulse={glance.tone === 'blue'} />}
        extra={
          <>
            <span className="ph-facts hide-phone">
              <span className="ph-sep">·</span>
              <span className="mono">{m.name ?? m.id}</span>
              {m.git && (
                <>
                  <span className="ph-sep">·</span>
                  <span className="mono">{m.git.branch}</span>
                </>
              )}
            </span>
          </>
        }
        detailsOpen={details}
        onToggleDetails={() => setDetails(!details)}
      />
      {m.status === 'deploying' && (
        <div className="sb-progress">
          <div className="indeterminate" />
          <span>{m.statusDetail ?? 'Setting up…'}</span>
        </div>
      )}
      {m.status === 'error' && <div className="banner banner-error">{m.statusDetail ?? 'Error'}</div>}
      <DetailsSheet open={details} onClose={() => setDetails(false)} title={displayName(m)}>
        <DetailsSection
          title="Machine"
          actions={
            <span className="details-actions">
              <button className="btn btn-ghost btn-sm" title="Change label" onClick={() => setLabel(true)}>
                <Icon name="edit" size={14} /> Label
              </button>
              <button className="btn btn-ghost btn-sm" title="Redeploy the daemon" disabled={m.status === 'deploying'} onClick={() => (live ? setConfirmRedeploy(true) : void redeploy())}>
                <Icon name="refresh" size={14} /> Redeploy
              </button>
              <button
                className="btn btn-ghost btn-sm"
                title={m.daemonStopped ? 'Start the daemon again' : `Restart the daemon (${m.platform === 'win32' ? 'its scheduled task' : m.platform === 'linux' ? 'its systemd user service' : 'its LaunchAgent'}) without redeploying`}
                disabled={m.status === 'deploying'}
                onClick={() => (live ? setConfirmRestart(true) : void controlDaemon())}
              >
                <Icon name="power" size={14} /> {m.daemonStopped ? 'Start' : 'Restart'}
              </button>
              <button className="btn btn-ghost btn-sm danger-hover" title="Remove machine" onClick={() => setConfirmRemove(true)}>
                <Icon name="trash" size={14} /> Remove
              </button>
            </span>
          }
        >
          <div className="details-row dim small">
            <span>
              Machine <span className="mono">{m.name ?? m.id}</span> · {machineKind(m)}
            </span>
            <span>{m.info?.hostname ?? `ssh ${m.host}`}</span>
          </div>
          <div className="sb-facts">
            <span className="fact mono">
              <Icon name="folder" size={13} /> <span className="ellipsis">{m.repoPath || 'repo not found yet'}</span>
              {m.repoPath && <CopyButton text={m.repoPath} label="Copy path" />}
            </span>
            {/* Its main clone's git, from a daemon before w536 only. */}
            {g && <GitFacts git={g} />}
            {(m.appDir || m.unityEditorRoot || m.unityPath || m.tempDir) && (
              <span className="fact mono" title="The machine's folders (add_machine app_dir, unity_editor_root, unity_path, temp_dir)">
                <Icon name="folder" size={13} />
                <span className="ellipsis dim">
                  {[
                    m.appDir && `daemon ${m.appDir}`,
                    m.unityPath ? `Unity ${m.unityPath}` : m.unityEditorRoot && `Unity versions ${m.unityEditorRoot}`,
                    m.tempDir && `temp ${m.tempDir}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
            )}
            {m.info && (
              <span className="fact">
                <Icon name="bot" size={13} />
                <span className="ellipsis dim">
                  {m.info.os} · node {m.info.node} · claude {m.info.claude ?? '?'} · daemon {m.info.daemon}
                </span>
              </span>
            )}
          </div>
          <div className="unity-bar">
            <Chip tone={machineTone(m)}>{machineLabel(m)}</Chip>
            <span className="dim small ellipsis">
              {m.online ? `${running}/${agentCap(m)} agents running` : m.lastSeen ? `last seen ${fmtRelative(m.lastSeen, now)}` : 'never connected'}
              {m.statusDetail && m.status === 'ready' ? ` · ${m.statusDetail}` : ''}
            </span>
          </div>
          {bench && (
            <div className="unity-bar" data-testid="machine-bench" data-mode={bench.mode} title={bench.hint}>
              <Chip tone={bench.tone}>Bench lock {bench.label}</Chip>
              <span className="dim small ellipsis">{[bench.detail, bench.times, bench.waiting, bench.next, bench.closed].filter(Boolean).join(' · ') || 'no ticket held or waiting'}</span>
            </div>
          )}
          {/* Its owner's pause (w1532): from its tray app, its schedule or a person's input; a paused machine takes no work. */}
          {m.pause && (
            <div className="unity-bar" data-testid="machine-pause">
              <Chip tone={m.pause.paused ? 'amber' : 'green'}>{m.pause.paused ? 'Paused' : 'Taking work'}</Chip>
              <span className="dim small ellipsis" title={m.pause.tray ? `tray app: ${m.pause.tray}` : undefined}>
                {m.pause.detail}
                {m.pause.paused ? ': no new work goes there, and its workers hand their requests back' : ''}
              </span>
            </div>
          )}
          {/* The activity pause (w1574): as the machine itself reports it; the switch sets its config machines.activityPause. */}
          {m.pause?.settings && <ActivityPause m={m} />}
        </DetailsSection>
        {(m.sandboxes?.length ?? 0) > 0 && (
          <DetailsSection title="Sandboxes">
            <div className="fl-sb-links">
              {m.sandboxes!.map((sb) => (
                <button key={sb.id} className="btn btn-ghost btn-sm" onClick={() => navigate({ view: 'msandbox', machineId: m.id, sandboxId: sb.id })} title={`${m.id}/${sb.id} · ${sb.git?.branch ?? sb.branch}`}>
                  <Icon name="folder" size={13} /> <span className="mono">{sb.id}</span>
                </button>
              ))}
            </div>
          </DetailsSection>
        )}
      </DetailsSheet>

      <div className="panel-empty">
        <Icon name="bot" size={28} />
        <p>{m.sandboxRoot ? "Workers run in this machine's sandboxes, each with its own page." : 'This machine has no sandboxes, so it takes no workers.'}</p>
        <p className="dim small">No agent works in its main clone. Its standing agents count against its agent cap too.</p>
      </div>

      {label && <LabelModal machine={m} onClose={() => setLabel(false)} />}
      {confirmRedeploy && (
        <Confirm
          title={`Redeploy ${m.id}?`}
          danger
          confirmLabel="Redeploy"
          body={<p>{live} agent(s) are running there. Redeploying restarts the daemon, which stops them; they resume when messaged.</p>}
          onConfirm={redeploy}
          onClose={() => setConfirmRedeploy(false)}
        />
      )}
      {confirmRestart && (
        <Confirm
          title={`Restart ${m.id}'s daemon?`}
          danger
          confirmLabel="Restart"
          body={<p>{live} agent(s) are running there. Restarting the daemon stops them; they resume when messaged.</p>}
          onConfirm={controlDaemon}
          onClose={() => setConfirmRestart(false)}
        />
      )}
      {confirmRemove && (
        <Confirm
          title={`Remove ${m.id}?`}
          danger
          confirmLabel="Remove machine"
          body={
            <>
              <p>Unloads its daemon over ssh and removes it and its agents from here.</p>
              <p className="dim">Nothing in its Final Factory clone is touched; the daemon's files stay in {m.appDir ?? '~/.ff-factory'}.</p>
            </>
          }
          onConfirm={async () => {
            const r = await attempt(api.removeMachine(m.id));
            if (r) {
              toast(r.note);
              navigate({ view: 'home' });
            }
          }}
          onClose={() => setConfirmRemove(false)}
        />
      )}
    </section>
  );
}

function LabelModal({ machine, onClose }: { machine: Machine; onClose: () => void }) {
  const [purpose, setPurpose] = useState(machine.purpose);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!purpose.trim() || busy) return;
    setBusy(true);
    const r = await attempt(api.labelMachine(machine.id, purpose.trim()));
    setBusy(false);
    if (r) {
      upsertMachine(r);
      onClose();
    }
  };
  return (
    <Modal
      title={
        <>
          Label <span className="mono accent">{machine.id}</span>
        </>
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!purpose.trim() || busy} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="field">
          <span>What it is being used for</span>
          <input className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="unused" autoFocus />
        </label>
      </form>
    </Modal>
  );
}

/** Add a machine: by default a join code and an installer the person runs on the new PC (w1592); or over ssh from this host. */
export function AddMachineModal({ app, onClose }: { app: AppState; onClose: () => void }) {
  const [mode, setMode] = useState<'join' | 'ssh'>('join');
  return mode === 'join' ? <JoinMachineModal app={app} onClose={onClose} onSsh={() => setMode('ssh')} /> : <SshMachineModal onClose={onClose} onJoin={() => setMode('join')} />;
}

/** Blank (its own) or 0..8; the server (checkJoinLimits) says which of those each limit takes. */
const LIMIT = /^[0-8]?$/;
const limitOf = (t: string) => (t.trim() ? Number(t.trim()) : undefined);

/** Saves `text` as a download named `name`, made here, so the code never sits in a URL or a server log. */
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * A join code for a new PC (w1592, docs/worker-install.md "Adding a machine with a join code"): one use, one hour, only on
 * the tailnet device named. The answer is the code, once, and a Windows installer with the code written in.
 */
function JoinMachineModal({ app, onClose, onSsh }: { app: AppState; onClose: () => void; onSsh: () => void }) {
  const [id, setId] = useState('');
  const [tailnet, setTailnet] = useState('');
  const [sandboxes, setSandboxes] = useState('');
  const [agents, setAgents] = useState('');
  const [unity, setUnity] = useState('');
  const [device, setDevice] = useState<{ name?: string; machine?: string }>({});
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<JoinAnswer>();
  const owner = app.me?.role === 'owner';
  useEffect(() => {
    if (!owner) return;
    let live = true;
    api
      .joinDevice()
      .then((d) => {
        if (!live) return;
        setDevice(d);
        // Opened on the new PC itself: name it after its tailnet device.
        if (d.name && !d.machine) {
          setId((v) => v || d.name!.slice(0, 24).replace(/-+$/, ''));
          setTailnet((v) => v || d.name!);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [owner]);
  const slug = id.trim().toLowerCase();
  const valid = owner && /^[a-z0-9][a-z0-9-]{0,23}$/.test(slug) && (!tailnet.trim() || /^[a-z0-9][a-z0-9-]*$/i.test(tailnet.trim())) && [sandboxes, agents, unity].every((t) => LIMIT.test(t.trim()));
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const r = await attempt(
      api.createJoin({
        id: slug,
        tailnetName: tailnet.trim() || undefined,
        maxSandboxes: limitOf(sandboxes),
        maxAgentsPerSandbox: limitOf(agents),
        maxUnity: limitOf(unity),
      }),
    );
    setBusy(false);
    if (r) {
      upsertMachine(r.machine);
      setMade(r);
    }
  };
  if (made) {
    const until = new Date(made.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return (
      <Modal
        title={`Add ${made.machine.id}`}
        onClose={onClose}
        footer={
          <button
            className="btn btn-primary"
            onClick={() => {
              navigate({ view: 'machine', machineId: made.machine.id });
              onClose();
            }}
          >
            Done
          </button>
        }
      >
        <div className="form" data-testid="join-made">
          <p>
            Join code <b className="mono">{made.code}</b> <CopyButton text={made.code} label="Copy the code" />
          </p>
          <p className="dim small">
            It works once, until {until}, and only on the tailnet device <span className="mono">{made.tailnetName}</span>. This is the only time it is shown.
          </p>
          {made.installer && (
            <p>
              <button className="btn btn-primary" onClick={() => download(made.installer!.name, made.installer!.text)}>
                Download the Windows installer
              </button>
              <br />
              <small className="dim">
                The code is in it. On {made.tailnetName}, connected to Tailscale, double-click it (Windows warns about a downloaded file first: More info, then Run anyway). It
                installs what is missing, sets the PC up and ends with a summary; the machine shows up here when its daemon connects.
              </small>
            </p>
          )}
          <p className="dim small">Or, on that PC, type the code into one of these:</p>
          <p className="small">
            PowerShell: <code className="mono">{made.windowsCommand}</code> <CopyButton text={made.windowsCommand} />
          </p>
          <p className="small">
            Mac or Linux terminal: <code className="mono">{made.unixCommand}</code> <CopyButton text={made.unixCommand} />
          </p>
          <p className="dim small">
            Or open <span className="mono">{made.page}</span> in that PC's browser.
          </p>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title="Add a machine"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
            {busy ? 'Making…' : 'Make the installer'}
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="dim small">
          A Windows PC, Mac or Linux PC on the tailnet joins by itself: you get a one-use join code and a Windows installer that carries it, to run on that PC. It installs
          Node, Git, Git LFS and Claude Code if missing, sets up the worker and connects back; no ssh set-up from here.{' '}
          <button type="button" className="link-btn" onClick={onSsh}>
            Set one up over ssh from this host instead
          </button>
        </p>
        {!owner && <p className="small">Only an owner can add a machine.</p>}
        <div className="field-row">
          <label className="field">
            <span>Id</span>
            <input className="input mono" value={id} onChange={(e) => setId(e.target.value)} placeholder="desktop-1" autoFocus />
          </label>
          <label className="field">
            <span>Its tailnet device name</span>
            <input className="input mono" value={tailnet} onChange={(e) => setTailnet(e.target.value)} placeholder={slug || 'same as the id'} />
          </label>
        </div>
        {device.name && !device.machine && <small className="dim">This browser is on the tailnet device {device.name}.</small>}
        <div className="field-row">
          <label className="field">
            <span>Sandboxes</span>
            <input className="input mono" inputMode="numeric" value={sandboxes} onChange={(e) => setSandboxes(e.target.value)} placeholder="from its RAM and disk" />
          </label>
          <label className="field">
            <span>Agents per sandbox</span>
            <input className="input mono" inputMode="numeric" value={agents} onChange={(e) => setAgents(e.target.value)} placeholder="2" />
          </label>
          <label className="field">
            <span>Unity editors at once</span>
            <input className="input mono" inputMode="numeric" value={unity} onChange={(e) => setUnity(e.target.value)} placeholder="from its RAM and CPUs" />
          </label>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Set up a Mac or a Windows PC over ssh from the portal host. */
function SshMachineModal({ onClose, onJoin }: { onClose: () => void; onJoin: () => void }) {
  const [id, setId] = useState('');
  const [host, setHost] = useState('');
  const [portalUrl, setPortalUrl] = useState(location.origin);
  const [repoPath, setRepoPath] = useState('');
  const [appDir, setAppDir] = useState('');
  const [unityRoot, setUnityRoot] = useState('');
  const [tempDir, setTempDir] = useState('');
  const [busy, setBusy] = useState(false);
  const slug = id.trim().toLowerCase();
  const valid = /^[a-z0-9][a-z0-9-]{0,23}$/.test(slug) && /^https?:\/\/[^/\s]+$/.test(portalUrl.trim().replace(/\/+$/, ''));
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const m = await attempt(
      api.addMachine({
        id: id.trim(),
        host: host.trim() || undefined,
        portalUrl: portalUrl.trim().replace(/\/+$/, ''),
        repoPath: repoPath.trim() || undefined,
        appDir: appDir.trim() || undefined,
        // A path to the executable itself (Unity.exe, .../MacOS/Unity) is unity_path; a folder of versions is unity_editor_root.
        ...(/(Unity\.exe|\/MacOS\/Unity)$/i.test(unityRoot.trim()) ? { unityPath: unityRoot.trim() } : { unityEditorRoot: unityRoot.trim() || undefined }),
        tempDir: tempDir.trim() || undefined,
      }),
    );
    setBusy(false);
    if (m) {
      upsertMachine(m);
      navigate({ view: 'machine', machineId: m.id });
      onClose();
    }
  };
  return (
    <Modal
      title="Add a machine"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
            {busy ? 'Starting…' : 'Set it up'}
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="dim small">
          Installs the FF Factory daemon on a Mac or Windows PC over ssh from this host (a LaunchAgent on a Mac, a scheduled task at logon on Windows) that runs agents
          there and connects back. The OS is found over ssh. Needs ssh key access, Node 22.6+ and git there; see docs/machines.md for a Windows PC's setup.{' '}
          <button type="button" className="link-btn" onClick={onJoin}>
            Add it with an installer run on the PC instead
          </button>
        </p>
        <div className="field-row">
          <label className="field">
            <span>Id</span>
            <input className="input mono" value={id} onChange={(e) => setId(e.target.value)} placeholder="m5" autoFocus />
          </label>
          <label className="field">
            <span>ssh host</span>
            <input className="input mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder={slug || 'same as the id'} />
          </label>
        </div>
        <label className="field">
          <span>Portal URL the machine connects to</span>
          <input className="input mono" value={portalUrl} onChange={(e) => setPortalUrl(e.target.value)} />
        </label>
        <label className="field">
          <span>Final Factory clone</span>
          <input className="input mono" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="found automatically" />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Daemon folder</span>
            <input className="input mono" value={appDir} onChange={(e) => setAppDir(e.target.value)} placeholder="~/.ff-factory" />
          </label>
          <label className="field">
            <span>Agents' temp folder</span>
            <input className="input mono" value={tempDir} onChange={(e) => setTempDir(e.target.value)} placeholder="the system's" />
          </label>
        </div>
        <label className="field">
          <span>Unity editors folder, or Unity executable</span>
          <input className="input mono" value={unityRoot} onChange={(e) => setUnityRoot(e.target.value)} placeholder="Unity Hub's folders" />
        </label>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

const IDLE_CHOICES = [15, 30, 60, 90, 120, 240];

/** "Pause on a person's input": off by default (w1574, lothsahn); on, a key or click pauses its work until N idle minutes. */
function ActivityPause({ m }: { m: Machine }) {
  const a = m.pause!.settings!.activity;
  const [busy, setBusy] = useState(false);
  const set = async (body: { enabled?: boolean; idleMinutes?: number }) => {
    setBusy(true);
    const r = await attempt(api.setActivityPause(m.id, body));
    setBusy(false);
    if (r) toast(`${m.id}: the activity pause is ${r.enabled ? `on (${r.idleMinutes} min idle)` : 'off'}`);
  };
  const idles = IDLE_CHOICES.includes(a.idleMinutes) ? IDLE_CHOICES : [...IDLE_CHOICES, a.idleMinutes].sort((x, y) => x - y);
  return (
    <div className="unity-bar" data-testid="machine-activity-pause">
      <Chip tone={a.enabled ? 'amber' : 'grey'}>{a.enabled ? 'Pauses on input' : 'Input ignored'}</Chip>
      <span className="dim small ellipsis">
        {a.enabled ? `A key or click on ${m.id} pauses its work until no one has used it for` : `Work goes on while someone uses ${m.id}`}
      </span>
      {a.enabled && (
        <select className="input input-sm" value={a.idleMinutes} disabled={busy} aria-label="Idle minutes before work resumes" onChange={(e) => void set({ idleMinutes: Number(e.target.value) })}>
          {idles.map((n) => (
            <option key={n} value={n}>
              {n} min
            </option>
          ))}
        </select>
      )}
      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void set({ enabled: !a.enabled })} title="Config machines.activityPause.enabled for this machine">
        {a.enabled ? 'Turn off' : 'Turn on'}
      </button>
    </div>
  );
}
