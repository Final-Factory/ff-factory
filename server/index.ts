import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import { HOST_ROLES, configPath, loadConfig, machineCleanupSettings, pruneRetiredKeys, publicIdentityOf, retiredKeysLine, ROOT } from './config.ts';
import { Store, bus } from './store.ts';
import { SessionManager, compactCommand, snapshotOf } from './sessions.ts';
import { TIMER_LIMITS } from './timers.ts';
import { Agents } from './agents.ts';
import { MachineManager, enrolledMachines, machineForPath, revokeMachineToken } from './machines.ts';
import { KEEP_CONVERSATIONS, ProviderManager, conversationQueryId, conversationView } from './providers.ts';
import { DevRequests } from './devRequests.ts';
import { MaxManager } from './max.ts';
import { IntakeManager } from './intake.ts';
import { LedgerSweep } from './ledgerSweep.ts';
import { BlockerWatch } from './blockerWatch.ts';
import { runWaitsMigration } from './waitsMigration.ts';
import { parseNightlyReport } from './nightlyRules.ts';
import { parseEscalation } from './escalationRules.ts';
import { groupIntake } from '../shared/intake.ts';
import { Notifier } from './notify.ts';
import { describeBusy } from './wake.ts';
import { machineLoadLine, systemStats } from './system.ts';
import { Auth } from './auth.ts';
import { Identity, asRequester, userToken } from './identity.ts';
import { handleMcp } from './mcp.ts';
import { IMAGE_TYPES, SOCKET_PING_MS, type ImageInput, type NotifyPrefs, type SendMessageRequest } from '../shared/types.ts';
import { listImages, MEDIA_TYPE, openVideo, parseRange, readImage, VIDEO_FILE } from './images.ts';
import { keepMessageImages } from './inlineImages.ts';
import { AttachmentError, AttachmentStore, downloadDisposition, machineAttachment, machineUploadHttp, publicRef } from './attachments.ts';
import { REVIEW_DEFAULTS, ReviewStore, reviewHttp } from './review.ts';
import { HostHealthMonitor } from './hostHealth.ts';
import { PATH_HEALTH_FILE, PathHealthMonitor, filePathHealth } from './pathHealth.ts';
import { withDismissed } from '../shared/dismissals.ts';
import { UNIT_WATCHDOG_FILE, UnitWatchdogMonitor, fileUnitWatchdog } from './unitWatchdog.ts';
import { dataRecoveries, describeRecovery } from './durable.ts';
import { DispatcherChatRefused } from './orchestrators.ts';
import { OPS_PEOPLE, OPS_REFUSED } from './opsWorker.ts';
import { backupMemory, healMemory, memoryRootOf } from './orchestratorMemory.ts';
import { describeMemoryGit, versionMemory } from './memoryGit.ts';
import { accountSetupLines, addSecretValues, claudeFromVault, hostAccount, hostAccountsInUse, reserveLines, hostRole, hostRoleOf, runsOnThisHost, scrubTranscripts, shownRoles, tokenFileToken, usesHostClaudeEnv } from './secrets.ts';
import { clock, firstFree, poolBanner, poolKind, poolLimits, warningsForUser } from './tokenPool.ts';
import { VAULT_FILE, VAULT_KINDS, VAULT_ROLES, Vault, keySource, setVaultContext, vaultStatusLine, type VaultKind, type VaultRole, type VaultShare } from './vault.ts';
import { collectNetwork, loadOutsideWatchState, outsideWatchConfig, saveOutsideWatchState, watchedPortalUrl, watcherOf } from './outsideWatch.ts';
import { endMaybeGzip } from './compress.ts';
import { serveStatic, webBuild } from './webStatic.ts';
import { appendCleanupLog, staleAtFile, biggestConsumers, cleanupRules, hostCleanupEnv, neverDelete, planCleanup, sessionTempDir, staleUnityLibraries, volumeStat } from './cleanup.ts';
import { cleanupPass, defaultNightlyRoots, planStaleOutput, staleContextOf, staleOutputSettings, type StalePlace } from './staleOutput.ts';
import { TASK_NAME, checkElevation } from './elevation.ts';
import { Drainer, clearPendingRestart, describeUncleanStop, mayRecoverUnclean, parseRestartRequest, readAlive, takePendingRestart, takeResumeFile, writeAlive, writePendingRestart, writeResumeFile, type RestartRequest } from './restart.ts';
import { UsageTracker, accountLines, buildAccounts, hostToken, machineToken, sessionSource, tokenKey, tokenLabel } from './usage.ts';
import { appVersion, formatVersion } from './version.ts';
import { VoiceService } from './voice.ts';
import { startBaseRefresh } from './baseRefresh.ts';
import { DRY_RUN_BANNER, DRY_RUN_WHY, defuseConfig, dryRun } from './dryRun.ts';
import { portalPublicKey, tailnetAddress } from './machineSsh.ts';
import { machineSshHttp } from './machineSshHttp.ts';
import { MAX_DICTATION_SECONDS, MAX_TTS_CHARS, buildVoicePrompt, wavSeconds, type SpeakRequest, type TranscribeRequest, type VocabularySource } from '../shared/voice.ts';
import type { AppState, CreateSandboxRequest, HostStatus, Machine, TokenWarning, PermissionDecisionRequest, Requester, ServerEvent, SessionInfo, SessionKind, StandingAgentInput, StartSessionRequest, SystemStats } from '../shared/types.ts';
import { slugify } from './sandboxes.ts';

const WEB = path.join(ROOT, 'web', 'dist');

/** The server's version plus the web UI build it serves now (server/webStatic.ts): an open page reloads when that changes. */
const appNow = () => ({ ...appVersion(), web: webBuild(WEB) });

const cfg = loadConfig();
// Keys the portal's own sandbox pool, editors and standing agents had (w510), which nothing reads: taken out of config.json
// at start (w852, Lothsahn: "Yes, remove unused config keys"; config.json.prev keeps the file as it was). A dry run's
// config is not its own to change, and one that cannot be written keeps them: named once, here and in system_status.
if (cfg.retiredKeys?.length && !dryRun()) {
  try {
    const removed = pruneRetiredKeys(configPath());
    if (removed.length) console.warn(`config: took ${removed.join(', ')} out of config.json, which nothing reads any more (w852; the file as it was is config.json.prev)`);
    cfg.retiredKeys = cfg.retiredKeys.filter((k) => !removed.includes(k));
  } catch (e) {
    console.warn(`config: could not take the retired keys out of config.json: ${(e as Error).message}`);
  }
}
const retiredKeys = retiredKeysLine(cfg.retiredKeys);
if (retiredKeys) console.warn(`config: ${retiredKeys}`);
fs.mkdirSync(cfg.dataDir, { recursive: true });
// The dry run (server/dryRun.ts, change 17): this portal runs on a copy of another's data and acts on nothing outside.
const isDryRun = dryRun();
if (isDryRun) {
  const ignored = defuseConfig(cfg);
  console.warn(`\n!!!!!!!! DRY RUN (FFSB_DRY_RUN=1). ${DRY_RUN_BANNER}${ignored.length ? ` Ignored: config ${ignored.join(' and ')}.` : ''}\n`);
}

// First of all, before anything is started: never run elevated (server/elevation.ts). Everything this
// server starts inherits its token: the orchestrators' shells would have admin rights.
const elevation = await checkElevation(cfg.dataDir);
if (elevation === 'exit') {
  console.log(`Running elevated: handed off to the Limited ${TASK_NAME} task (scripts/restart.ps1 relaunches the app non-elevated). Exiting.`);
  process.exit(0);
}
const host: HostStatus = { elevated: elevation.elevated, elevatedWhy: elevation.why, ...(isDryRun ? { dryRun: DRY_RUN_BANNER } : {}) };
if (host.elevated) {
  console.error(
    `\n!!!!!!!! FF Factory is running WITH ADMINISTRATOR RIGHTS: every orchestrator shell inherits admin rights. ${host.elevatedWhy ?? ''}` +
      // From a shell without admin rights restart.ps1 cannot stop an elevated app (docs/restart.md, "Never elevated").
      `${host.elevatedWhy?.includes('Fix:') ? '' : ' Fix: right-click scripts\\restart.cmd > Run as administrator (or run scripts\\restart.ps1 from an administrator shell).'}\n`,
  );
}

// When the last server was last alive (its heartbeat), read before this one beats: after an unclean stop it
// dates the outage and tells a power cut (the machine booted since) from a server crash.
const lastAlive = readAlive(cfg.dataDir);
writeAlive(cfg.dataDir);
setInterval(() => writeAlive(cfg.dataDir), 30_000);

const store = new Store(cfg.dataDir);
// The orchestrators' memory (Claude Code writes it, so it cannot be written crash-safe): a file a crash damaged gets its
// newest good backup back, and a backup is taken every 10 minutes when something changed (server/orchestratorMemory.ts).
const memoryRoot = memoryRootOf(cfg);
// When the memory root is a git repository of its own, each backup pass also commits what changed and pushes it, to a
// private remote only (server/memoryGit.ts; docs/orchestrators.md, "Memory in a private repository").
let lastMemoryGit = '';
const versionMemoryNow = () => {
  // A dry run pushes nothing: the memory's remote is the real portal's.
  if (isDryRun) return;
  const pub = publicIdentityOf(cfg);
  const identity = pub.name && pub.email ? { name: pub.name, email: pub.email } : { name: 'FF Factory', email: 'ff-factory@users.noreply.github.com' };
  void versionMemory(memoryRoot, { identity })
    .then((r) => {
      const line = describeMemoryGit(r);
      // A push that keeps failing says so once, not every ten minutes.
      if (line && (r.state === 'pushed' || line !== lastMemoryGit)) console[r.state === 'pushed' ? 'log' : 'warn'](line);
      lastMemoryGit = line ?? '';
    })
    .catch((e) => console.warn(`orchestrator memory versioning failed: ${(e as Error).message}`));
};
const guardMemory = (what: 'heal' | 'backup') => {
  try {
    if (what === 'heal') healMemory(memoryRoot);
    else {
      backupMemory(memoryRoot);
      versionMemoryNow();
    }
  } catch (e) {
    console.warn(`orchestrator memory ${what} failed: ${(e as Error).message}`);
  }
};
guardMemory('heal');
guardMemory('backup');
setInterval(() => guardMemory('backup'), 10 * 60_000).unref();
// The token vault (docs/vault.md, w512): data/vault.json, sealed with a key outside data/. Loaded first, so redaction knows
// its values (registerSecretValues) before any transcript is written or scrubbed.
// systemd's credentials folder (the VM: the vault key) is kept here and taken out of the environment every agent inherits.
const credentialsDir = process.env.CREDENTIALS_DIRECTORY;
delete process.env.CREDENTIALS_DIRECTORY;
const vault = new Vault({ file: path.join(cfg.dataDir, VAULT_FILE), key: () => keySource(cfg, { CREDENTIALS_DIRECTORY: credentialsDir }), onValues: addSecretValues });
// Transcripts written before redaction existed: no Claude OAuth or Discord token stays on disk (server/secrets.ts).
setTimeout(() => {
  const n = scrubTranscripts(path.join(cfg.dataDir, 'transcripts'));
  if (n) console.log(`secrets: redacted secrets (Claude OAuth or Discord tokens) in ${n} transcript(s)`);
}, 5000);
const sessions = new SessionManager(cfg, store);
const machines = new MachineManager(cfg, store, sessions);
// The machines' host keys, pinned from their records (w568): a rebuilt or moved portal writes them again.
if (!dryRun()) machines.pinHostKeys();
// Files people attach to messages (docs/attachments.md): stored by SHA-256, never opened; old ones go by retention.
const attachments = new AttachmentStore(cfg.dataDir, () => cfg.attachments);
machines.attachments = attachments;
const pruneAttachments = () => {
  try {
    const r = attachments.prune();
    if (r.records || r.blobs || r.partials) console.log(`attachments: retention removed ${r.records} record(s), ${r.blobs} stored file(s), ${r.partials} unfinished upload(s)`);
  } catch (e) {
    console.warn(`attachments: retention failed: ${(e as Error).message}`);
  }
};
setTimeout(pruneAttachments, 60_000).unref();
setInterval(pruneAttachments, 60 * 60_000).unref();
// FFBox, through the connector it runs (docs/ffbox-integration.md): read-only reports, off by default.
const providers = new ProviderManager(cfg);
// Max, the Discord bot agents post as (docs/max.md): their ffdiscord calls, the token's health, a read-only inbound.
const max = new MaxManager(cfg, {
  session: (id) => store.sessions.get(id),
  standingName: (id) => store.standing.get(id)?.name,
}).start();
machines.maxEvent = (machineId, line) => max.ingestLine(line, machineId);
// A daemon that has not come back 2 minutes after a restart (or a drop) while ssh reaches its Mac is redeployed.
// The machines' own Unity watch: tell the orchestrator and the user, and the machine's agents after a restart.
machines.unityEvent = (machineId, text, restarted, sandbox) => {
  const line = `[unity] machine ${machineId}: ${text}`;
  console.log(line);
  notifier.host(`Unity on ${machineId}${sandbox ? `/${sandbox}` : ''}${restarted ? ' restarted' : ''}`, text);
  const orch = store.orchestratorId;
  if (orch) {
    try {
      sessions.send(orch, line, 'system');
    } catch {
      // no orchestrator right now
    }
  }
  if (!restarted) return;
  const recent = Date.now() - 30 * 60_000;
  for (const s of store.sessions.values()) {
    // Only the agents of that editor's sandbox (workers run in sandboxes only, w536).
    if (s.machineId !== machineId || s.kind === 'standing' || s.machineSandbox !== sandbox || s.stoppedOnPurpose) continue;
    if (!['running', 'starting', 'waiting_permission'].includes(s.status) && Date.parse(s.lastActivityAt) < recent) continue;
    try {
      sessions.send(s.id, `Unity ${sandbox ? `of your sandbox (${sandbox})` : 'on this machine'} was restarted automatically at ${new Date().toLocaleTimeString()} (${text.split(';')[0]}). Re-pin it (mcpforunity://instances, then set_active_instance) once its bridge is up, and continue where you left off.`, 'system');
    } catch {
      // offline or at its limit: it sees the editor state on its next Unity call
    }
  }
};
machines.sandboxEvent = (machineId, text, e) => {
  const line = `[sandboxes] ${machineId}: ${text}`;
  console.log(line);
  if (e.checkpoint) notifier.host(`Disk critical on ${machineId}`, text);
  const orch = store.orchestratorId;
  if (orch) {
    try {
      sessions.send(orch, line, 'system');
    } catch {
      // no orchestrator right now
    }
  }
  if (!e.checkpoint) return;
  // The machine's disk guard: its sandbox agents mid-turn commit, push and stop (as the host's guard asks its own).
  for (const s of store.sessions.values()) {
    if (s.machineId !== machineId || !s.machineSandbox || !['running', 'starting', 'waiting_permission'].includes(s.status)) continue;
    try {
      sessions.send(s.id, '[disk critical] Free disk space on this machine is critically low. Commit and push your work now (a WIP commit is fine) and end your turn; new work waits until space is freed. You will be told when to continue.', 'system');
    } catch {
      // it sees the refusal on its next start
    }
  }
};
machines.report = (text) => {
  console.log(text);
  const orch = store.orchestratorId;
  if (orch) {
    try {
      sessions.send(orch, text, 'system');
    } catch {
      // no orchestrator right now
    }
  }
};
// Each machine's own clean-up (docs/self-recovery.md): its settings, and a notice when it cannot free enough.
// The portal's own host as a machine (docs/beast-machine.md) cleans nothing itself: this host's guard already cleans
// this computer, with its own rules, and counts that daemon's running agents' temp folders as in use.
machines.cleanupFor = (id) => (store.machines.get(id)?.local ? { everyMinutes: 0, softFreeGB: 0 } : machineCleanupSettings(cfg, id));
// The stale-output rules (w459) attribute build and run output to the ledger's requests: each daemon gets its facts
// at connect and every 10 minutes, and its every pass is kept here too (data/cleanup/<machine>/cleanup-log.jsonl).
machines.cleanupContext = () => staleContextOf(store.work.values());
machines.cleanupLog = (machineId, entry) => appendCleanupLog(path.join(cfg.dataDir, 'cleanup', machineId.replace(/[^\w.-]/g, '_')), { machine: machineId, ...entry });
setInterval(() => machines.pushCleanupContext(), 10 * 60_000).unref();
machines.cleanupNotice = (machineId, text) => {
  notifier.host(`Disk space on ${machineId}`, text);
  machines.report?.(`[machine ${machineId}] Clean-up cannot free enough disk space. ${text}`);
};
// The outside watchdog (docs/self-recovery.md): a Mac watches this host and alerts the user's phone through ntfy.
const outside = loadOutsideWatchState(cfg.dataDir);
const watcher = () =>
  cfg.outsideWatch?.enabled === false || isDryRun
    ? undefined
    : watcherOf(
        cfg.outsideWatch?.machine,
        machines.list().map((m) => m.id),
        machines.list().filter((m) => m.local).map((m) => m.id),
      );
// Without publicUrl, the address the other machines were deployed with (add_machine's portal_url) is the same portal; the
// local machine's loopback address is not (w424).
const portalUrl = () => watchedPortalUrl(cfg.publicUrl, machines.list());
const watchConfig = () => outsideWatchConfig({ ...cfg.outsideWatch, publicUrl: portalUrl(), name: os.hostname() }, outside);
machines.outsideWatchFor = (id) => (id === watcher() ? (watchConfig() ?? null) : null);
const learnNetwork = () =>
  void collectNetwork()
    .then((n) => {
      if (!n || (n.mac === outside.mac && n.broadcast === outside.broadcast && n.ip === outside.ip)) return;
      Object.assign(outside, n, { collectedAt: new Date().toISOString() });
      saveOutsideWatchState(cfg.dataDir, outside);
      machines.pushOutsideWatch();
    })
    .catch((e) => console.warn('outside watch: could not read the LAN adapter:', (e as Error).message));
learnNetwork();
setInterval(learnNetwork, 6 * 3_600_000);
setInterval(() => {
  void machines.watchOffline().catch((e) => console.warn('machine watchdog:', (e as Error).message));
  machines.checkOutdated();
}, 30_000);
const auth = new Auth(cfg.dataDir, { trustProxy: cfg.trustProxy });
// Who is who (docs/identity.md): the logins in data/users.json, and who automatic work is billed to.
const identity = new Identity(cfg, () => auth.userInfos());
const agents = new Agents(cfg, store, sessions, machines, identity);
agents.attachments = attachments;
// Review media workers publish (docs/review.md): <sandboxRoot>/_review unless config review.root says otherwise.
const review = new ReviewStore(() => ({ ...REVIEW_DEFAULTS, ...cfg.review, root: cfg.review?.root ?? path.join(cfg.sandboxRoot, '_review') }));
agents.review = review;

/** The signed-in person making this request, as work records them (a route only runs for a signed-in user). */
function requesterOf(req: http.IncomingMessage) {
  const u = auth.userInfo(auth.user(req));
  return u ? asRequester(u) : identity.owner();
}

/**
 * Who may drive an orchestrator (docs/orchestrators.md): a person's own only by that person, the dispatcher's controls
 * (permissions, mode, interrupt) only by an owner. Nobody writes the dispatcher a message (the message route refuses it).
 * So one person's chat never gets the other's messages, and nobody spends someone else's Claude account.
 */
function mayDrive(req: http.IncomingMessage, s: SessionInfo) {
  // The orchestration worker (w597): only Lothsahn and Ben interrupt it from the page; nobody writes to it there.
  if (s.kind === 'ops') {
    if (!OPS_PEOPLE.includes(requesterOf(req).userId.toLowerCase())) throw new HttpError(403, OPS_REFUSED);
    return;
  }
  if (s.kind !== 'orchestrator') return;
  const me = requesterOf(req);
  const owner = agents.orchestrators.ownerOf(s);
  if (owner) {
    if (owner.userId.toLowerCase() !== me.userId.toLowerCase()) throw new HttpError(403, `this is ${owner.displayName}'s own orchestrator; write to yours`);
    return;
  }
  if (identity.get(me.userId)?.role !== 'owner') throw new HttpError(403, "only the owner answers the dispatcher's permission requests or changes its mode; ask your own orchestrator, which files work with it");
}
const notifier = new Notifier(cfg.dataDir, store, sessions);
notifier.orchestratorId = () => store.orchestratorId;
// Who hears about a session (docs/orchestrators.md): a person's own orchestrator only them, the dispatcher's turns
// nobody (its questions and errors the owners), a worker's finished turns the people it works for.
notifier.audience = (s, kind) => {
  const owner = agents.orchestrators.ownerOf(s);
  if (owner) return [owner.userId];
  if (agents.orchestrators.isDispatcher(s)) return kind === 'turnEnd' ? [] : identity.list().filter((u) => u.role === 'owner').map((u) => u.userId);
  // A worker's finished turn: the people it works for, and whoever wrote to it last (they may be following it).
  // Intake work nobody asked for in person (docs/intake.md) reaches people through the ledger and the heartbeat instead.
  if (s.kind === 'worker' && kind === 'turnEnd' && agents.orchestrators.intakeOnly(s.id)) return [];
  if (s.kind === 'worker' && kind === 'turnEnd') return [...new Set([...agents.orchestrators.audienceOf(s), ...(s.lastRequestedBy ? [s.lastRequestedBy] : [])].map((r) => r.userId.toLowerCase()))];
  return undefined;
};
agents.orchestrators.onPersonMessage = (from, to, text) => notifier.personMessage(from, to, text);
agents.standing.events.on('run', (a, run) => notifier.standingRun(a, run));
agents.standing.events.on('delegation', (d) => notifier.delegation(d));
agents.standing.events.on('delegationUpdate', (d, what) => notifier.delegationUpdate(d, what));
// The portal's host guard (docs/self-recovery.md): its data volume, RAM and the clean-up of this computer. No sandbox
// drive: the portal holds no sandboxes (w510); a machine's drive is its daemon's guard's (machine/hostGuard.ts, w466).
const cleanupEnv = { ...hostCleanupEnv(), sandboxRoots: [cfg.sandboxRoot] };
/**
 * What clean-up never touches here: the sandbox root (this host's own daemon's), the old standing agents' folders, the
 * base clone, this app and its data, and the temp folders of agents running now.
 */
const hostCleanupGuard = () => ({
  keep: [...cfg.protectedPaths, cfg.sandboxRoot, cfg.standingRoot, cfg.repo.basePath, ROOT, cfg.dataDir, cfg.hostGuard.devDriveVhdx].filter(Boolean),
  // The orchestrators, and the agents this host's own daemon runs (they get their temp folder under the same %TEMP%).
  inUse: [...sessions.sessions.values()].filter((s) => s.live && (!s.info.machineId || store.machines.get(s.info.machineId)?.local)).map((s) => sessionTempDir(os.tmpdir(), s.info.id)),
  home: cleanupEnv.home,
});
/**
 * Where agents work on this host, for the stale-output rules (w459): its own daemon's sandboxes (that daemon cleans
 * nothing itself, machines.cleanupFor), each with whether its editor is known to be stopped, and the base clone.
 */
const hostStalePlaces = (): StalePlace[] => {
  const stopped = (state: string) => state === 'stopped' || state === 'crashed';
  const local = machines.local();
  return [
    ...(local?.sandboxes ?? []).filter((s) => s.status === 'ready').map((s) => ({ id: `${local!.id}/${s.id}`, path: s.path, kind: 'sandbox' as const, editorRunning: !stopped(s.unity.state) })),
    { id: 'base clone', path: cfg.repo.basePath, kind: 'clone' as const },
  ];
};
const hostHealth = new HostHealthMonitor({
  cfg,
  // With the filesystem type and the device: a RAM-backed temp folder is never the disk (w566).
  statfs: volumeStat,
  exists: (p) => fs.existsSync(p),
  mem: () => ({ free: os.freemem(), total: os.totalmem() }),
  // No sandboxes, editors or drive of its own (w510): those are each machine's daemon's, this host's own daemon's too.
  sandboxes: () => [],
  sessions: () => [...store.sessions.values()],
  watchDrive: () => false,
  startEditor: async () => undefined,
  stopEditor: async () => undefined,
  interrupt: (id) => sessions.get(id).interrupt(),
  tell: (id, text) => void sessions.send(id, text, 'system', undefined, { bypassGate: true }),
  report: (title, body) => {
    console.log(`host guard: ${title}: ${body}`);
    notifier.host(title, body);
    const orch = store.orchestratorId;
    if (orch) {
      try {
        sessions.send(orch, `[host] ${title}. ${body}`, 'system');
      } catch {
        // the orchestrator is not there; the notification still went out
      }
    }
  },
  runHelper: async (action) => ({ action, ok: false, at: new Date().toISOString(), detail: 'the portal has no sandbox drive (w510)' }),
  cleanup: {
    pass: async (low, opts) => {
      const guard = hostCleanupGuard();
      const libraries = cfg.hostGuard.cleanup.libraryDeleteDays > 0 ? { roots: [cleanupEnv.home], deleteDays: cfg.hostGuard.cleanup.libraryDeleteDays } : undefined;
      const settings = staleOutputSettings(cfg.hostGuard.cleanup.staleOutput);
      // A sandbox's Builds/ is the stale-output rules' (attributed, or listed): the old 7-day age rule only when they are off.
      const env = settings.mode === 'off' ? cleanupEnv : { ...cleanupEnv, sandboxRoots: [] };
      const r = await cleanupPass({
        opts,
        guard,
        mode: settings.mode,
        regular: () => planCleanup({ rules: cleanupRules(env, cfg.hostGuard.cleanup), guard, low, libraries }),
        stale: () => planStaleOutput({ places: hostStalePlaces(), nightlyRoots: settings.nightlyRoots ?? defaultNightlyRoots(process.platform, cleanupEnv.home), ctx: staleContextOf(store.work.values()), settings, guard }),
      });
      return r;
    },
    consumers: () => biggestConsumers(cleanupEnv, [cfg.hostGuard.devDriveVhdx].filter(Boolean)),
    stale: async () => (await staleUnityLibraries([cleanupEnv.home], cfg.hostGuard.cleanup.libraryReportDays)).filter((l) => !neverDelete(l.path, hostCleanupGuard())),
    log: (e) => appendCleanupLog(cfg.dataDir, e),
    staleAt: staleAtFile(cfg.dataDir),
    // The disk is the volume(s) of the home folder and the data; the temp folder is shown apart (in the VM a tmpfs of half
    // the RAM, which as "the disk" read 1.9 GB free while the disk had 101 GB, w566).
    diskPaths: () => [cleanupEnv.home, cfg.dataDir],
    tempPaths: () => [cleanupEnv.tmp],
  },
  changed: (h) => {
    host.health = h;
    broadcast({ type: 'host', host: { ...host, drain: drainer.status } });
  },
  log: (line) => console.warn(line),
});
// A machine's own host guard (w466: BEAST's daemon, its drive, disks and reaper) reports like this host's.
machines.hostReport = (id, title, body) => {
  console.log(`host guard on ${id}: ${title}: ${body}`);
  notifier.host(`${id}: ${title}`, body);
  const orch = store.orchestratorId;
  if (orch) {
    try {
      sessions.send(orch, `[host ${id}] ${title}. ${body}`, 'system');
    } catch {
      // the orchestrator is not there; the notification still went out
    }
  }
};
agents.hostHealth = hostHealth;
// The path from the internet through Funnel to this portal, as the FFBox host's watchdog reports it (w681, server/pathHealth.ts).
const pathHealth = new PathHealthMonitor({
  read: filePathHealth(process.env.FFF_PATH_HEALTH_FILE || PATH_HEALTH_FILE),
  now: () => Date.now(),
  changed: (h) => {
    host.pathHealth = h;
    broadcast({ type: 'host', host: { ...host, drain: drainer.status } });
  },
  report: (title, body) => {
    console.log(`path health: ${title}: ${body}`);
    if (isDryRun) return;
    notifier.host(title, body);
    const orch = store.orchestratorId;
    if (orch) {
      try {
        sessions.send(orch, `[host] ${title}. ${body}`, 'system');
      } catch {
        // the orchestrator is not there; the notification still went out
      }
    }
  },
  log: (line) => console.warn(line),
});
setInterval(() => pathHealth.tick(), 15_000);
setTimeout(() => pathHealth.tick(), 5000); // after the drainer (the banner broadcast reads it)
// What the VM's unit watchdog (fff-health, every 30 s) restarted and why (server/unitWatchdog.ts).
const unitWatchdog = new UnitWatchdogMonitor({
  read: fileUnitWatchdog(process.env.FFF_UNIT_WATCHDOG_FILE || path.join(cfg.dataDir, UNIT_WATCHDOG_FILE)),
  now: () => Date.now(),
  changed: (u) => {
    host.unitWatchdog = u;
    broadcast({ type: 'host', host: { ...host, drain: drainer.status } });
  },
  report: (title, body) => {
    console.log(`unit watchdog: ${title}: ${body}`);
    if (isDryRun) return;
    notifier.host(title, body);
    const orch = store.orchestratorId;
    if (orch) {
      try {
        sessions.send(orch, `[host] ${title}. ${body}`, 'system');
      } catch {
        // the orchestrator is not there; the notification still went out
      }
    }
  },
  log: (line) => console.warn(line),
});
setInterval(() => unitWatchdog.tick(), 15_000);
setTimeout(() => unitWatchdog.tick(), 5500);
agents.providers = providers;
agents.max = max;
// The intake (docs/intake.md): Discord and FFBox into the work ledger. Everything in it is off unless config intake
// switches it on; the hooks below only record what already arrives while it is off.
const intake = new IntakeManager({
  cfg,
  store,
  identity,
  orchestrators: agents.orchestrators,
  discord: max,
  pushBoard: (ref, answer) => providers.pushBoard(ref, answer),
  pushReportFixed: (fix) => providers.pushReportFixed(fix),
  pushReportObsolete: (o) => providers.pushReportObsolete(o),
  // FFBox runs ffbox master, which takes maybe: no offer list gates it (docs/ffbox-connector-contract.md, "No negotiation").
  takesMaybe: () => true,
}).start();
// The ledger cleanup (docs/orchestrators.md, "Ledger cleanup"): requests whose PRs merged close, quiet ones stall.
const ledgerSweep = new LedgerSweep({
  cfg,
  store,
  orchestrators: agents.orchestrators,
  resume: (id, text) => void sessions.send(id, text, 'system'),
  limitsClear: (s) => limitsClearFor(s),
  intakeMerged: () => intake.checkMerged(false),
  // A request whose last step is machine updates closes once each connected machine runs its merge (w631).
  daemons: () => machines.daemonVersions(),
}).start();
// Blocked requests (w643, docs/orchestrators.md "Waiting, Queued, Blocked"): each starts by itself when its blocker clears.
let nightlyAt: number | undefined;
const blockerWatch = new BlockerWatch({
  store,
  orchestrators: agents.orchestrators,
  portalSha: () => appVersion().sha,
  daemonSha: (id) => agents.daemonSha?.(id),
  online: (id) => (store.machines.has(id.toLowerCase()) ? machines.isOnline(id.toLowerCase()) : undefined),
  usageClear: (account) => accountClear(account),
  nightlyAt: () => nightlyAt,
  room: () => agents.roomNow(),
});
agents.blockerWatch = blockerWatch;
agents.daemonSha = (id) => machines.daemonVersions().find((d) => d.id === id.toLowerCase())?.sha;
// The orchestrators' base clone, kept on origin's newest code (w467, server/baseRefresh.ts; config repo.refreshMinutes).
startBaseRefresh(cfg);
max.onEvent = (ev) => intake.onMaxEvent(ev);
providers.onConversation = (c) => intake.onConversation(c);
providers.onRequest = (m) => intake.onRequest(m);
providers.onBoardCheck = (m) => intake.onBoardCheck(m);
providers.onWorkReply = (m) => intake.onWorkReply(m);
providers.onResult = (m) => intake.onResult(m);
// FFBox operators' ffdev turns handed over (docs/ffbox.md, "Dev requests"): filed as the operator's mapped person's own.
providers.dev = new DevRequests(
  {
    cfg,
    identity,
    orchestrators: agents.orchestrators,
    attachments,
    sendFiles: (id, text, files, requestedBy) => agents.sendWithAttachments(id, text, 'system', { attachments: files, requestedBy }),
    sendText: (id, text, requestedBy) => void sessions.send(id, text, 'system', undefined, { requestedBy }),
    // An operator's own authenticated words: a turn of theirs, as if typed in FF Factory (w831).
    sendAsPerson: (person, text) => void agents.operatorTurn(person, text),
  },
  providers.devLink(),
);
// A linked request's branch, PR, merge, release or end goes to FFBox as a dev_update (queued until FFBox confirms it),
// on every work event and once a minute for what changes without one (a worker's PR opening).
bus.on('event', (e) => {
  if (e.type === 'work') providers.dev?.workChanged(e.item);
});
setInterval(() => providers.dev?.recheck(), 60_000).unref();
agents.orchestrators.onIntakeAttention = (w, what) => notifier.intake(w, what, (what === 'design' && w.flag ? w.flag.for : agents.orchestrators.reviewers()).map((r) => r.userId));
if (cfg.hostGuard.pollSeconds > 0) {
  setInterval(() => void hostHealth.tick(), cfg.hostGuard.pollSeconds * 1000);
  setTimeout(() => void hostHealth.tick(), 5000);
}
if (!auth.hasUsers()) console.warn('No users yet. Create one on this machine: node server/user.ts <username>');
const cutOff = agents.boot();
// Once, on the first start with w643: requests queued with a note naming what they wait on become Blocked on it, and the
// dispatcher gets the before and after of every open and stalled request (data/w643-migration.md).
runWaitsMigration({
  dataDir: cfg.dataDir,
  items: () => [...store.work.values()],
  block: (id, b, line) =>
    void agents.orchestrators.ledgerEdit(id, line, (x) => {
      x.status = 'blocked';
      x.blocked = b;
    }),
  live: () => agents.workLive(),
  portalSha: appVersion().sha,
  machines: [...store.machines.keys()],
  tell: (text) => agents.orchestrators.toDispatcher(text),
});
blockerWatch.start();

let lastSystem: SystemStats | undefined;

/** The app as `user` (a login name) sees it: their own orchestrator is the home chat (made on first sight). */
function appState(user: string | undefined): AppState {
  const u = auth.userInfo(user);
  const me = u ?? { ...identity.owner(), role: 'owner' as const };
  const mine = agents.orchestrators.personalFor(me);
  return {
    app: appNow(),
    sessions: [...store.sessions.values()],
    standingAgents: agents.standing.list(),
    delegations: [...store.delegations.values()],
    machines: machines.list(),
    providers: providers.enabled || providers.summary().tokenSet ? [providers.summary()] : [],
    ffbox: providers.summary(),
    max: max.summary(),
    system: lastSystem,
    host: hostForUser({ ...host, drain: drainer.status }, me.userId),
    usage: usage.usage,
    accounts: accountsNow(),
    machineStats: machines.allStats(),
    orchestratorId: mine.info.id,
    dispatcherId: agents.dispatcherId,
    me,
    work: agents.orchestrators.forPage(),
    room: agents.roomNow(),
    intake: intake.summary(),
    ledger: ledgerSweep.state(),
    config: { defaultModel: cfg.defaultModel, models: cfg.models, defaultBase: cfg.defaultBase, attachments: attachments.settings },
    settings: store.settings,
  };
}

// ------------------------------------------------------------------ http helpers

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body ?? {});
  // Gzipped when big (server/compress.ts): /api/state at thousands of sessions is megabytes.
  void endMaybeGzip(res.req, res, status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }, json);
}

async function readJson<T>(req: http.IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

const need = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `"${name}" is required`);
  return v;
};

// ------------------------------------------------------------------ routes

type Handler = (req: http.IncomingMessage, params: string[], url: URL) => Promise<unknown>;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, pattern: string, h: Handler) => routes.push([method, new RegExp(`^${pattern}$`), h]);

route('GET', '/api/state', async (req) => appState(auth.user(req)));
route('GET', '/api/me', async (req) => {
  const u = auth.userInfo(auth.user(req));
  return { username: auth.user(req), ...(u ?? {}) };
});

// ---- providers (docs/ffbox-integration.md): what FFBox's connector reported, newest first
route('GET', '/api/providers/ffbox/conversations', async (_r, _m, url) => providers.conversations(Number(url.searchParams.get('limit')) || 100));
route('GET', '/api/providers/ffbox/intake', async (_r, _m, url) => providers.intake(Number(url.searchParams.get('limit')) || 200));
// One conversation, read through the connector (w426): FFBox's own page is on Lothsahn's network only.
route('GET', '/api/providers/ffbox/conversation/([A-Za-z0-9._:-]{1,80})', async (_r, [id], url) => {
  const offset = Math.max(0, Math.min(Number(url.searchParams.get('offset')) || 0, 100000));
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 10, 20));
  const summary = providers.conversations(KEEP_CONVERSATIONS).find((c) => c.id === id);
  return conversationView(id, await providers.query('conversation', { id: conversationQueryId(id), offset, limit }), summary);
});
// Grouped by coarse signature, with the numbers automatic investigations will be capped by (shared/intake.ts).
route('GET', '/api/providers/ffbox/signatures', async () => groupIntake(providers.intake(2000)));

// ---- Max (docs/max.md): what agents did as Max, the token's health, and a read-only look at a few channels
route('GET', '/api/max/activity', async (_r, _m, url) => max.activity(Number(url.searchParams.get('limit')) || 100));
route('GET', '/api/max/inbound', async () => max.inbound());
route('POST', '/api/max/inbound/([\\w-]+)/seen', async (_r, [alias]) => {
  try {
    max.markSeen(alias);
  } catch (e) {
    throw new HttpError(404, (e as Error).message);
  }
  return { ok: true };
});
route('POST', '/api/max/refresh', async () => max.refresh());

// ---- the intake (docs/intake.md): Discord and FFBox requests in the ledger; a person approves or declines them
route('GET', '/api/intake', async () => intake.summary());
route('POST', '/api/intake/poll', async () => intake.checkNow());
// The ledger cleanup now (an owner's): what it closed, resumed and stalled, in a line.
route('POST', '/api/ledger/cleanup', async (req) => {
  if (identity.get(requesterOf(req).userId)?.role !== 'owner') throw new HttpError(403, 'only the owner runs the ledger cleanup');
  return { summary: await ledgerSweep.run() };
});
route('POST', '/api/work/(w[0-9]+)/approve', async (req, [id]) => {
  const w = agents.orchestrators.approveIntake(id, requesterOf(req));
  return { id: w.id, status: w.status, approval: w.approval };
});
route('POST', '/api/work/(w[0-9]+)/decline', async (req, [id]) => {
  const b = await readJson<{ note?: string }>(req);
  const w = agents.orchestrators.declineIntake(id, requesterOf(req), typeof b.note === 'string' ? b.note.slice(0, 300) : undefined);
  return { id: w.id, status: w.status, approval: w.approval };
});
// ---- the token vault (docs/vault.md, w512): the owner's only. A value goes in and is never sent back: every answer is
// the entries' metadata (fingerprint, last four characters). No orchestrator tool reaches these routes.
const requireOwner = (req: http.IncomingMessage) => {
  if (auth.userInfo(auth.user(req))?.role !== 'owner') throw new HttpError(403, 'only an owner manages the token vault');
};
const vaultView = () => ({
  status: vault.status(),
  entries: vault.list(),
  kinds: VAULT_KINDS,
  roles: VAULT_ROLES,
  people: identity.list().map((u) => ({ userId: u.userId, displayName: u.displayName })),
  machines: machines.list().map((m) => ({ id: m.id, online: machines.isOnline(m.id), claudeFromVault: claudeFromVault(cfg, m) })),
  enrolled: enrolledMachines(cfg.dataDir),
});
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : undefined);
const vaultChanged = () => usage.poke();
route('GET', '/api/vault', async (req) => {
  requireOwner(req);
  return vaultView();
});
route('POST', '/api/vault', async (req) => {
  requireOwner(req);
  const b = await readJson<Record<string, unknown>>(req, 64 * 1024);
  vault.add({
    name: String(b.name ?? '').trim(),
    kind: String(b.kind ?? '') as VaultKind,
    value: typeof b.value === 'string' ? b.value.trim() : '',
    env: typeof b.env === 'string' && b.env.trim() ? b.env.trim() : undefined,
    owner: typeof b.owner === 'string' && b.owner.trim() ? b.owner.trim() : undefined,
    email: typeof b.email === 'string' && b.email.trim() ? b.email.trim() : undefined,
    share: (b.share as VaultShare | undefined) ?? undefined,
    roles: strings(b.roles) as VaultRole[] | undefined,
    machines: strings(b.machines),
  });
  vaultChanged();
  return vaultView();
});
route('POST', '/api/vault/([a-z0-9._-]{1,40})/rotate', async (req, [name]) => {
  requireOwner(req);
  const b = await readJson<{ value?: unknown }>(req, 64 * 1024);
  vault.rotate(name, typeof b.value === 'string' ? b.value.trim() : '');
  vaultChanged();
  return vaultView();
});
route('PATCH', '/api/vault/([a-z0-9._-]{1,40})', async (req, [name]) => {
  requireOwner(req);
  const b = await readJson<Record<string, unknown>>(req, 16 * 1024);
  vault.update(name, {
    ...(typeof b.owner === 'string' ? { owner: b.owner.trim() } : {}),
    ...(typeof b.email === 'string' ? { email: b.email.trim() } : {}),
    ...(b.share !== undefined ? { share: b.share as VaultShare } : {}),
    ...(b.roles !== undefined ? { roles: (strings(b.roles) ?? []) as VaultRole[] } : {}),
    ...(b.machines !== undefined ? { machines: strings(b.machines) ?? [] } : {}),
    ...(typeof b.disabled === 'boolean' ? { disabled: b.disabled } : {}),
  });
  vaultChanged();
  return vaultView();
});
route('DELETE', '/api/vault/([a-z0-9._-]{1,40})', async (req, [name]) => {
  requireOwner(req);
  vault.remove(name);
  vaultChanged();
  return vaultView();
});
// Revoke a machine's credential (docs/vault.md, section 3): its link drops now, its record stays. A new one comes from
// `fffctl machine-credential issue` or a redeploy (add_machine).
route('POST', '/api/machines/([a-z0-9-]{1,40})/revoke-credential', async (req, [id]) => {
  requireOwner(req);
  if (!revokeMachineToken(cfg.dataDir, id)) throw new HttpError(404, `machine ${id} holds no credential`);
  machines.dropRevoked();
  return vaultView();
});
// The usage meters' Refresh: poll every account now, here and on each connected machine (docs/accounts.md).
route('POST', '/api/usage/refresh', async () => ({ started: usage.refreshNow(), machines: machines.requestUsage() }));

route('GET', '/api/sessions/([\\w-]+)/events', async (_r, [id], url) => {
  sessions.get(id);
  // from=<seq>: everything from there on (a search hit older than the usual last 500).
  const from = Number(url.searchParams.get('from'));
  if (from > 0) return store.readTranscriptFrom(id, from);
  return store.readTranscript(id, Number(url.searchParams.get('limit')) || 500);
});

// ---- transcript search (server/search.ts)

route('GET', '/api/search', async (_r, _p, url) => {
  const q = url.searchParams;
  return agents.search({
    query: need(q.get('q'), 'q'),
    sandbox: q.get('sandbox') || undefined,
    machine: q.get('machine') || undefined,
    agent: q.get('agent') || undefined,
    since: q.get('since') || undefined,
    until: q.get('until') || undefined,
    limit: Number(q.get('limit')) || undefined,
  });
});

route('POST', '/api/sessions/([\\w-]+)/message', async (req, [id]) => {
  // The page has no input here; a direct POST gets this error.
  agents.orchestrators.refuseHumanChat(sessions.get(id).info);
  // Images come base64 in the JSON (the UI shrinks them first), so this body may be large.
  const { text, images, attachments: attachmentIds } = await readJson<SendMessageRequest>(req, 40 * 1024 * 1024);
  const imgs = checkImages(images);
  // Other files were uploaded first (POST /api/attachments): the message names them by id (docs/attachments.md).
  const files = attachments.resolve(attachmentIds);
  const s = sessions.get(id);
  // A standing agent only works inside a run (budget, no overlap, agent limit): a message starts one.
  if (s.info.kind === 'standing' && s.info.standingId) {
    if (imgs.length) throw new HttpError(400, 'standing agents take text only; describe the image or put it in their folder');
    if (files.length) throw new HttpError(400, 'standing agents take text only; attach the file in an orchestrator or worker chat');
    return { note: agents.standing.runNow(s.info.standingId, 'message', need(text, 'text'), requesterOf(req)) };
  }
  if (!imgs.length && !files.length) need(text, 'text');
  if (s.info.kind === 'ops') throw new HttpError(403, OPS_REFUSED);
  mayDrive(req, s.info);
  // `/compact [focus]` (w518) is no message: it compacts the conversation. Its wake_me check-in and budgets stay.
  const focus = s.info.kind === 'orchestrator' && !imgs.length && !files.length ? compactCommand(String(text ?? '')) : undefined;
  if (focus !== undefined) return { note: compactNow(id, focus, requesterOf(req)) };
  if (s.info.kind === 'orchestrator') {
    // A person wrote to their orchestrator: its own wake_me check-in is moot, and its budgets start again.
    agents.waker.cancel(id);
    agents.orchestrators.personWrote(id);
  }
  // The calls a gate refused in earlier turns ride along with the person's message (w830), marked as FF Factory's.
  const said = String(text ?? '').trim() + (s.info.kind === 'orchestrator' ? agents.orchestrators.heldOffer(id) : '');
  await agents.sendWithAttachments(id, said, 'human', { images: imgs, attachments: files, requestedBy: requesterOf(req) });
  return {};
});

/** Compact an orchestrator's conversation (w518); a refusal is a 409 the page shows. */
function compactNow(id: string, focus: string, by: Requester): string {
  try {
    return sessions.compact(id, focus, by);
  } catch (e) {
    throw new HttpError(409, `Not compacted: ${(e as Error).message}.`);
  }
}

// `/compact` as a button (w518): a person's own orchestrator for them, the dispatcher (nobody chats with it) for an owner.
route('POST', '/api/sessions/([\\w-]+)/compact', async (req, [id]) => {
  const s = sessions.get(id);
  if (s.info.kind !== 'orchestrator') throw new HttpError(400, '/compact is for the orchestrators\' chats');
  mayDrive(req, s.info);
  const { instructions } = await readJson<{ instructions?: string }>(req);
  return { note: compactNow(id, String(instructions ?? ''), requesterOf(req)) };
});

// A person opened their own chat: the messages other people sent them there are read (docs/orchestrators.md).
route('POST', '/api/sessions/([\\w-]+)/seen', async (req, [id]) => {
  const s = sessions.get(id);
  mayDrive(req, s.info);
  agents.orchestrators.seen(id);
  return {};
});

// ---- orchestrator timers (server/timers.ts, docs/orchestrators.md "Timers"): its person sees and pauses or cancels
// their own orchestrator's; the dispatcher's only an owner (mayDrive). Nobody else sees them.
route('GET', '/api/timers/([\\w-]+)', async (req, [id]) => {
  const s = sessions.get(id);
  if (s.info.kind !== 'orchestrator') throw new HttpError(400, 'timers belong to orchestrators');
  mayDrive(req, s.info);
  return { timers: agents.timers.list(id), deliveredToday: agents.timers.deliveredToday(id), limits: TIMER_LIMITS };
});
route('POST', '/api/timers/([\\w-]+)/([\\w-]+)', async (req, [id, timerId]) => {
  const s = sessions.get(id);
  if (s.info.kind !== 'orchestrator') throw new HttpError(400, 'timers belong to orchestrators');
  mayDrive(req, s.info);
  const { action } = await readJson<{ action?: string }>(req);
  try {
    if (action === 'pause') agents.timers.update(id, timerId, { enabled: false });
    else if (action === 'resume') agents.timers.update(id, timerId, { enabled: true });
    else if (action === 'cancel') agents.timers.cancel(id, timerId);
    else throw new HttpError(400, 'action: pause, resume or cancel');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, (e as Error).message);
  }
  return { timers: agents.timers.list(id), deliveredToday: agents.timers.deliveredToday(id), limits: TIMER_LIMITS };
});

/** Validate images sent with a message. */
function checkImages(images: unknown): ImageInput[] {
  if (images === undefined) return [];
  if (!Array.isArray(images) || images.length > 8) throw new HttpError(400, 'images: at most 8 per message');
  return images.map((i) => {
    const mediaType = String((i as ImageInput)?.mediaType ?? '');
    const data = String((i as ImageInput)?.data ?? '');
    if (!IMAGE_TYPES.includes(mediaType)) throw new HttpError(400, `images: ${mediaType || 'unknown type'} is not PNG, JPEG, GIF or WebP`);
    if (!data || data.length > 14_000_000 || !/^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 200))) throw new HttpError(400, 'images: each must be base64 and under ~10 MB');
    return { mediaType, data: data.replace(/\s/g, '') };
  });
}

// ---- images: kept uploads, files agents mention, the Screenshots galleries

/** A route may return a file instead of JSON. */
/** A file streamed to the client, honouring an HTTP Range request (videos: seeking, and iPad Safari). */
class StreamReply {
  readonly type: string;
  readonly path: string;
  readonly size: number;
  /** A download (an attachment): saved under this Content-Disposition, never shown. */
  readonly disposition?: string;
  constructor(type: string, file: string, size: number, disposition?: string) {
    this.type = type;
    this.path = file;
    this.size = size;
    this.disposition = disposition;
  }
}

/** Served files are never pages: an SVG opened on its own runs nothing and loads nothing, in an origin of its own. */
const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

class FileReply {
  readonly type: string;
  readonly data: Buffer;
  constructor(type: string, data: Buffer) {
    this.type = type;
    this.data = data;
  }
}

// ---- attachments (docs/attachments.md): files people attach to messages, uploaded in chunks that resume

route('POST', '/api/attachments', async (req) => {
  const b = await readJson<{ name?: unknown; size?: unknown }>(req);
  return attachments.begin({ name: b.name, size: b.size, uploadedBy: auth.user(req) });
});
route('GET', '/api/attachments/uploads/([a-f0-9]{32})', async (_r, [uploadId]) => attachments.status(uploadId));
// A chunk is raw bytes (application/octet-stream with the x-ff-upload header, which the CSRF check lets through).
route('PUT', '/api/attachments/uploads/([a-f0-9]{32})', async (req, [uploadId], url) => {
  const length = req.headers['content-length'];
  const r = await attachments.append(uploadId, Number(url.searchParams.get('offset')), req, undefined, length === undefined ? undefined : Number(length));
  return { received: r.received, size: r.size, ...(r.attachment ? { attachment: publicRef(r.attachment) } : {}) };
});
route('DELETE', '/api/attachments/uploads/([a-f0-9]{32})', async (_r, [uploadId]) => {
  attachments.cancel(uploadId);
  return {};
});
route('GET', '/api/attachments/(att_[a-z0-9]{12})', async (_r, [id]) => {
  const [a] = attachments.resolve([id]);
  return { ...publicRef(a), createdAt: a.createdAt, lastUsedAt: a.lastUsedAt, ...(a.uploadedBy ? { uploadedBy: a.uploadedBy } : {}) };
});
// Always a download, as bytes: never shown in the page (an HTML or SVG file must not run here).
route('GET', '/api/attachments/(att_[a-z0-9]{12})/download', async (_r, [id]) => {
  const [a] = attachments.resolve([id]);
  return new StreamReply('application/octet-stream', attachments.pathOf(a), a.size, downloadDisposition(a.name));
});

route('GET', '/api/uploads/([\\w-]+)/([\\w-]+)', async (_r, [sessionId, imageId]) => {
  const f = store.imagePath(sessionId, imageId);
  if (!f) throw new HttpError(404, 'no such image');
  return new FileReply(MEDIA_TYPE[f.split('.').pop()!] ?? 'application/octet-stream', fs.readFileSync(f));
});

/**
 * Where a session, sandbox or machine may show images from. `machine` means: ask that machine's daemon
 * (`session`: for that session, whose own temp folder it adds).
 */
type ImageRoots = { machine?: string; session?: string; roots: string[] };
function imageRoots(url: URL, file?: string): ImageRoots {
  // Review media (docs/review.md) is on this computer whoever published it, a worker on a machine included.
  if (file && review.contains(file)) return { roots: [review.root] };
  const sessionId = url.searchParams.get('session');
  const machineId = url.searchParams.get('machine');
  if (machineId) return { machine: machines.require(machineId).id, roots: [] };
  if (!sessionId) throw new HttpError(400, 'give session or machine');
  return sessionImageRoots(sessionId, file);
}

/**
 * A session's folders: its sandbox or standing agent folder and its own temp folder. The orchestrator oversees
 * everything: the base clone, every sandbox and standing agent folder, and (for a path under a machine's clone or
 * home) that machine's own folders, which its daemon checks.
 */
function sessionImageRoots(sessionId: string, file?: string): ImageRoots {
  const s = sessions.get(sessionId).info;
  if (s.machineId) return { machine: s.machineId, session: s.id, roots: [] };
  const temp = sessionTempDir(os.tmpdir(), s.id);
  if (s.standingId) return { roots: [agents.standing.require(s.standingId).folder, temp] };
  if (s.kind === 'orchestrator') {
    const onMachine = file ? machineForPath(file, machines.list()) : undefined;
    if (onMachine) return { machine: onMachine.id, roots: [] };
    return { roots: [cfg.repo.basePath, cfg.sandboxRoot, cfg.standingRoot] };
  }
  throw new HttpError(404, 'no folder for this session');
}

const readImageIn = (where: ImageRoots, file: string) => (where.machine ? machines.readImage(where.machine, file, where.session) : Promise.resolve(readImage(file, where.roots)));

route('GET', '/api/image', async (_r, _p, url) => {
  const file = need(url.searchParams.get('path'), 'path');
  const where = imageRoots(url, file);
  try {
    if (VIDEO_FILE.test(file)) {
      if (where.machine) throw new Error('videos on a machine cannot be shown yet');
      const v = openVideo(file, where.roots);
      return new StreamReply(v.mediaType, v.path, v.size);
    }
    const img = await readImageIn(where, file);
    return new FileReply(img.mediaType, img.data);
  } catch (e) {
    throw new HttpError(404, (e as Error).message);
  }
});

route('GET', '/api/screenshots', async (_r, _p, url) => {
  const where = imageRoots(url);
  if (where.machine) return machines.listImages(where.machine, cfg.screenshotDirs);
  return listImages(where.roots[0], cfg.screenshotDirs, 120, { videos: true });
});

route('POST', '/api/sessions/([\\w-]+)/title', async (req, [id]) => {
  const { title } = await readJson<{ title?: string }>(req);
  const s = sessions.get(id);
  if (s.info.kind === 'standing') throw new HttpError(400, "a standing agent's conversation carries the agent's name; rename the agent instead");
  if (s.info.kind === 'orchestrator') throw new HttpError(400, "an orchestrator's name is its person's (or Dispatcher)");
  if (s.info.kind === 'ops') throw new HttpError(400, 'the orchestration worker keeps its name');
  return { title: sessions.setTitle(id, need(title, 'title')) };
});

route('POST', '/api/sessions/([\\w-]+)/interrupt', async (req, [id]) => {
  const s = sessions.get(id);
  mayDrive(req, s.info);
  await s.interrupt();
  return {};
});

route('POST', '/api/sessions/([\\w-]+)/permission', async (req, [id]) => {
  const b = await readJson<PermissionDecisionRequest>(req);
  const s = sessions.get(id);
  mayDrive(req, s.info);
  if (!s.decide(need(b.requestId, 'requestId'), !!b.allow, b.message)) throw new HttpError(404, 'no such pending request');
  return {};
});

route('POST', '/api/sessions/([\\w-]+)/mode', async (req, [id]) => {
  const { mode } = await readJson<{ mode: string }>(req);
  if (!['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto'].includes(mode)) throw new HttpError(400, 'bad mode');
  const s = sessions.get(id);
  if (s.info.kind === 'ops') throw new HttpError(400, "the orchestration worker's permission mode is fixed (its guard and the VM's fences hold it)");
  mayDrive(req, s.info);
  await s.setMode(mode as never);
  return {};
});

route('POST', '/api/sessions', async (req) => {
  const b = await readJson<StartSessionRequest>(req);
  // A sandbox a waiting worker released on its own branch is switched to a fresh one first (w640).
  await agents.prepareForNewWork(b.sandboxId || undefined, b.machineId || undefined);
  const s = agents.startWorker({
    sandbox: b.sandboxId || undefined,
    machine: b.machineId || undefined,
    prompt: need(b.prompt, 'prompt'),
    title: b.title,
    model: b.model,
    permissionMode: b.permissionMode,
    effort: b.effort,
    from: 'human',
    requestedBy: requesterOf(req),
  });
  // Started from the dashboard: in the ledger too, so it shows all work in flight (docs/intake.md, "One place").
  if (s.info.status !== 'error') {
    const by = requesterOf(req);
    const where = s.info.machineSandbox ? `in ${s.info.machineId}/${s.info.machineSandbox}` : s.info.machineId ? `on ${s.info.machineId}` : `in ${s.info.sandboxId}`;
    agents.orchestrators.recordStart(s.info, b.prompt, by, `started by ${by.displayName} from the dashboard: worker ${s.info.id} ${where}`, true);
  }
  return s.info;
});

route('DELETE', '/api/sessions/([\\w-]+)', async (_r, [id]) => {
  const s = sessions.get(id);
  if (s.info.kind === 'orchestrator') throw new HttpError(400, 'reset the orchestrator instead');
  if (s.info.kind === 'standing') throw new HttpError(400, "this is a standing agent's conversation; delete the agent instead");
  if (s.info.kind === 'ops') throw new HttpError(400, 'the orchestration worker is fixed: stop it instead (its conversation stays)');
  sessions.remove(id);
  return {};
});

/** A fresh conversation: your own orchestrator's (the default), or the dispatcher's (an owner only). */
route('POST', '/api/orchestrator/reset', async (req) => {
  const { which } = await readJson<{ which?: 'mine' | 'dispatcher' }>(req);
  const me = requesterOf(req);
  let id: string;
  let was: string | undefined;
  if (which === 'dispatcher') {
    if (identity.get(me.userId)?.role !== 'owner') throw new HttpError(403, 'only the owner resets the dispatcher');
    was = agents.dispatcherId;
    id = agents.newDispatcher().info.id;
  } else {
    was = agents.orchestrators.personalOf(me.userId)?.info.id;
    id = agents.orchestrators.resetPersonal(me).info.id;
  }
  // A fresh conversation keeps its standing timers (server/timers.ts): they are the person's jobs, not the transcript's.
  if (was) agents.timers.rehome(was, id);
  // Each page has its own home chat, so each gets its own state.
  for (const [c, user] of clients) if (c.readyState === c.OPEN) c.send(JSON.stringify({ type: 'state', state: appState(user) } satisfies ServerEvent));
  return { id };
});

// The New sandbox form: made on this host's own daemon (docs/beast-machine.md); the portal holds none itself (w510).
route('POST', '/api/sandboxes', async (req) => {
  const b = await readJson<CreateSandboxRequest>(req);
  need(b.name, 'name');
  const on = agents.defaultSandboxMachine();
  if (!on) throw new HttpError(400, "this portal holds no sandboxes of its own and this host has no machine daemon with a sandbox root: ask the orchestrator for one on a machine (create_sandbox with machine)");
  const note = await machines.createSandbox(on, b);
  return { machine: on, id: slugify(b.name), note };
});

// ---- standing agents (docs/standing-agents.md)

route('POST', '/api/standing', async (req) => {
  const body = await readJson<StandingAgentInput>(req);
  // Its delegations are filed as its owner's requests (w527): the person who made it, unless the body names another.
  return agents.standing.create({ ...body, owner: body.owner ?? requesterOf(req) });
});

route('POST', '/api/standing/([\\w-]+)', async (req, [id]) => agents.standing.update(id, await readJson<Partial<StandingAgentInput>>(req)));

route('DELETE', '/api/standing/([\\w-]+)', async (_r, [id]) => {
  agents.standing.remove(id);
  return {};
});

route('POST', '/api/standing/([\\w-]+)/(run|stop|pause|resume)', async (req, [id, action]) => {
  const st = agents.standing;
  if (action === 'run') return { note: st.runNow(id, 'manual', undefined, requesterOf(req)) };
  if (action === 'stop') return { note: st.stop(id) };
  return action === 'pause' ? st.pause(id) : st.resume(id);
});

route('POST', '/api/delegations/([\\w-]+)/(approve|reject|bump)', async (req, [id, action]) => {
  // w527: approving files it in the ledger for the agent's owner (no free slot needed); bump also asks to start it now.
  if (action === 'approve') return agents.standing.approveDelegation(id, { approvedBy: requesterOf(req) });
  if (action === 'bump') return agents.standing.bumpDelegation(id, requesterOf(req));
  const { note } = await readJson<{ note?: string }>(req);
  return agents.standing.rejectDelegation(id, note);
});

// ---- notifications (server/notify.ts)

route('GET', '/api/push', async (req) => ({ publicKey: notifier.publicKey, subscriptions: notifier.list(auth.user(req)!) }));

route('POST', '/api/push/subscribe', async (req) => {
  const b = await readJson<{ subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }; prefs?: Partial<NotifyPrefs> }>(req);
  return { prefs: notifier.subscribe(auth.user(req)!, b.subscription ?? {}, b.prefs, deviceName(String(req.headers['user-agent'] ?? ''))) };
});

route('POST', '/api/push/prefs', async (req) => {
  const b = await readJson<{ endpoint?: string; prefs?: Partial<NotifyPrefs> }>(req);
  return { prefs: notifier.setPrefs(need(b.endpoint, 'endpoint'), b.prefs ?? {}) };
});

route('POST', '/api/push/unsubscribe', async (req) => {
  const b = await readJson<{ endpoint?: string }>(req);
  notifier.unsubscribe(need(b.endpoint, 'endpoint'));
  return {};
});

route('POST', '/api/push/test', async (req) => {
  const b = await readJson<{ endpoint?: string }>(req);
  return { delivered: await notifier.test(auth.user(req)!, b.endpoint) };
});

/** "iPhone", "Android", "Mac", "Windows" + browser: enough to tell devices apart in the list. */
function deviceName(ua: string) {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Linux';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${br} on ${os}`;
}

// ---- settings (heartbeat) and wake-ups (server/wake.ts)

/** heartbeatMinutes: the signed-in person's own heartbeat (docs/orchestrators.md). */
route('POST', '/api/settings', async (req) => {
  const b = await readJson<{ heartbeatMinutes?: number | null }>(req);
  const m = b.heartbeatMinutes;
  if (m !== undefined && m !== null && (!Number.isInteger(m) || m < 5 || m > 240)) throw new HttpError(400, 'heartbeatMinutes: 5 to 240, or null for off');
  if (m !== undefined) agents.setHeartbeat(requesterOf(req).userId, m);
  return store.settings;
});

/**
 * The signed-in person closed a banner about these events (w751): remembered for them alone, until the events are gone;
 * a new event shows the banner again. Body: { keys: string[] } (shared/dismissals.ts unitEventKey).
 */
route('POST', '/api/dismiss', async (req) => {
  const b = await readJson<{ keys?: unknown }>(req);
  if (!Array.isArray(b.keys) || b.keys.length > 100 || b.keys.some((k) => typeof k !== 'string' || !k || k.length > 400)) throw new HttpError(400, 'keys: a list of up to 100 event keys (strings)');
  store.putSettings({ dismissedEvents: withDismissed(store.settings.dismissedEvents, requesterOf(req).userId, b.keys as string[]) });
  return store.settings;
});

// Each person's heartbeat wakes their own orchestrator, with their own busy workers.
setInterval(() => {
  const describe = (s: SessionInfo) => describeBusy(s, { machine: s.machineId });
  for (const [userId, minutes] of Object.entries(store.settings.heartbeat ?? {})) {
    const chat = agents.orchestrators.personalOf(userId);
    if (!chat) continue;
    agents.waker.heartbeat(chat.info.id, minutes, describe, (s) => agents.orchestrators.audienceOf(s).some((r) => r.userId.toLowerCase() === userId.toLowerCase()), () => agents.orchestrators.intakeLine(userId));
  }
}, 60_000);

// ---- switch_branch (server/switchBranch.ts)

route('POST', '/api/machines/([\\w-]+)/switch-branch', async (req, [id]) => {
  const b = await readJson<{ branch?: string; createFrom?: string }>(req);
  return { note: await agents.switchBranch({ machine: id, branch: need(b.branch, 'branch').trim(), createFrom: b.createFrom?.trim() || undefined }) };
});

// ---- a machine sandbox's page (docs/machines.md, "Machine sandboxes"): its editor, its log, its branch

route('POST', '/api/machines/([\\w-]+)/sandboxes/([\\w-]+)/unity', async (req, [id, sb]) => {
  const { action } = await readJson<{ action?: string }>(req);
  if (action !== 'start' && action !== 'stop') throw new HttpError(400, 'action must be start or stop');
  return { note: await machines.unity(id, action, false, sb) };
});

route('GET', '/api/machines/([\\w-]+)/sandboxes/([\\w-]+)/unity-log', async (_r, [id, sb], url) => ({
  lines: (await machines.sandboxLog(id, sb, Math.min(5000, Number(url.searchParams.get('lines')) || 200))).split('\n'),
}));

route('POST', '/api/machines/([\\w-]+)/sandboxes/([\\w-]+)/switch-branch', async (req, [id, sb]) => {
  const b = await readJson<{ branch?: string; createFrom?: string }>(req);
  return { note: await agents.switchBranch({ machine: id, sandbox: sb, branch: need(b.branch, 'branch').trim(), createFrom: b.createFrom?.trim() || undefined }) };
});

// ---- machines (docs/machines.md)

route('POST', '/api/machines', async (req) => {
  const b = await readJson<{ id?: string; host?: string; portalUrl?: string; repoPath?: string; appDir?: string; unityEditorRoot?: string; unityPath?: string; tempDir?: string } & Pick<Machine, 'sandboxRoot' | 'maxSandboxes' | 'maxAgentsPerSandbox' | 'maxUnity' | 'diskWarnGB' | 'diskCriticalGB'>>(req);
  return machines.deployMachine({
    id: need(b.id, 'id'),
    host: b.host,
    portalUrl: b.portalUrl,
    repoPath: b.repoPath || undefined,
    appDir: b.appDir,
    unityEditorRoot: b.unityEditorRoot,
    unityPath: b.unityPath,
    tempDir: b.tempDir,
    sandboxRoot: b.sandboxRoot,
    maxSandboxes: b.maxSandboxes,
    maxAgentsPerSandbox: b.maxAgentsPerSandbox,
    maxUnity: b.maxUnity,
    diskWarnGB: b.diskWarnGB,
    diskCriticalGB: b.diskCriticalGB,
  });
});

route('POST', '/api/machines/([\\w-]+)/redeploy', async (req, [id]) => {
  const b = await readJson<{ force?: boolean }>(req);
  return machines.deployMachine({ id, force: !!b.force });
});

route('POST', '/api/machines/([\\w-]+)/daemon', async (req, [id]) => {
  const b = await readJson<{ action?: string; force?: boolean }>(req);
  if (b.action !== 'start' && b.action !== 'stop' && b.action !== 'restart') throw new HttpError(400, 'action must be start, stop or restart');
  return { note: await machines.controlDaemon(id, b.action, !!b.force) };
});

route('POST', '/api/machines/([\\w-]+)/label', async (req, [id]) => {
  const { purpose } = await readJson<{ purpose?: string }>(req);
  return machines.setPurpose(id, need(purpose, 'purpose'));
});

route('DELETE', '/api/machines/([\\w-]+)', async (_r, [id]) => ({ note: await machines.removeMachine(id) }));

// ---- voice input (server/voice.ts, docs/voice.md)

// A worker machine's GPU Whisper first when one offers it, this portal's own as the fallback (w615).
const voice = new VoiceService(cfg, () => buildVoicePrompt(vocabulary()), {
  machines: (order) => machines.voiceMachines(order),
  transcribe: (machine, req, timeoutMs) => machines.transcribeOn(machine, req, timeoutMs),
  warm: (machine) => machines.warmVoice(machine),
});
voice.autoInstall();

let specCache: { at: number; names: string[] } | undefined;
/** Names Whisper should know, from the current state: sandboxes, machines, agents, recent specs. */
function vocabulary(): VocabularySource {
  if (!specCache || Date.now() - specCache.at > 10 * 60_000) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(cfg.repo.basePath, 'specs'));
    } catch {
      /* no base clone yet */
    }
    specCache = { at: Date.now(), names };
  }
  const recent = [...store.sessions.values()]
    .filter((s) => s.kind !== 'orchestrator' && s.kind !== 'standing')
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    .slice(0, 12);
  return {
    sandboxes: machines.list().flatMap((m) => m.sandboxes ?? []),
    machines: machines.list().map((m) => m.id),
    agentNames: [...agents.standing.list().map((a) => a.name), ...recent.map((s) => s.title)],
    specs: specCache.names,
    extra: cfg.voice.vocabulary,
  };
}

route('GET', '/api/voice', async () => voice.status());
// Recording started: load the model now, so it is ready when the clip arrives. Voice mode also
// warms text-to-speech ({ tts: true }): a reply will be read.
route('POST', '/api/voice/warm', async (req) => {
  const { tts } = await readJson<{ tts?: boolean }>(req);
  return voice.warm({ tts: !!tts });
});
route('POST', '/api/voice/install', async () => {
  void voice.install();
  return voice.status();
});
route('POST', '/api/voice/transcribe', async (req) => {
  // 16 kHz 16-bit mono is 32 KB/s; base64 adds a third.
  const { audio } = await readJson<TranscribeRequest>(req, Math.ceil(((MAX_DICTATION_SECONDS + 10) * 32_000 * 4) / 3) + 1024);
  const wav = Buffer.from(need(audio, 'audio'), 'base64');
  const seconds = wavSeconds(wav);
  if (seconds === undefined) throw new HttpError(400, 'audio: expected a 16-bit PCM WAV');
  if (seconds > MAX_DICTATION_SECONDS + 5) throw new HttpError(413, `audio: at most ${MAX_DICTATION_SECONDS} s`);
  try {
    return await voice.transcribe(wav);
  } catch (e) {
    throw new HttpError(503, (e as Error).message);
  }
});
// Voice mode reads replies aloud: text -> WAV, a sentence or a few at a time.
route('POST', '/api/voice/tts', async (req) => {
  const { text, voice: v, speed } = await readJson<SpeakRequest>(req);
  const t = need(text, 'text').trim();
  if (t.length > MAX_TTS_CHARS) throw new HttpError(413, `text: at most ${MAX_TTS_CHARS} characters`);
  if (v !== undefined && !/^[a-z]{2}_[a-z]+$/.test(v)) throw new HttpError(400, 'voice: a Kokoro voice name like af_heart');
  const sp = speed === undefined ? 1 : Number(speed);
  if (!(sp >= 0.5 && sp <= 2)) throw new HttpError(400, 'speed: 0.5 to 2');
  try {
    const r = await voice.speak(t, v, sp);
    return new FileReply('audio/wav', r.wav);
  } catch (e) {
    throw new HttpError(503, (e as Error).message);
  }
});

// ------------------------------------------------------------------ server

/** Parse a request path without ever throwing (a raw "//" or "//x:99999" request line makes WHATWG URL throw). */
function parseUrl(raw: string | undefined): URL | undefined {
  try {
    return new URL(raw ?? '/', 'http://x');
  } catch {
    return undefined;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = parseUrl(req.url);
    if (!url) return send(res, 400, { error: 'bad request' });
    if (url.pathname === '/mcp') {
      // Machine clients authenticate with an API key, not a browser session; no cookies, so no CSRF.
      const who = auth.bearer(req);
      if (!who.ok) return send(res, who.status, { error: who.status === 429 ? 'too many failures' : 'API key required' });
      if (who.scope) return send(res, 403, { error: `this key is for ${who.scope} reports only` });
      // A key bound to a login acts for that person; an unbound one (made before keys had users) for the owner.
      const keyUser = auth.userInfo(who.user);
      return await handleMcp(agents, who.name, keyUser ? asRequester(keyUser) : identity.owner(), req, res, req.method === 'POST' ? await readJson(req) : undefined);
    }
    if (url.pathname.startsWith('/api/') && req.method !== 'GET') {
      // CSRF: a cross-site form cannot send application/json, and SameSite=Strict keeps the cookie home. An attachment
      // chunk is raw bytes instead, with a custom header that no cross-site form or simple request can carry.
      const chunk = req.method === 'PUT' && url.pathname.startsWith('/api/attachments/uploads/');
      if (chunk) {
        if (req.headers['x-ff-upload'] !== '1' || !String(req.headers['content-type'] ?? '').startsWith('application/octet-stream')) {
          return send(res, 415, { error: 'an attachment chunk is application/octet-stream with x-ff-upload: 1' });
        }
      } else if (req.method !== 'DELETE' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return send(res, 415, { error: 'JSON only' });
      }
    }
    // A machine's daemon fetching an attachment it was handed (docs/attachments.md): its own token, no browser session.
    const machineFile = req.method === 'GET' ? /^\/machine\/attachments\/(att_[a-z0-9]{12})$/.exec(url.pathname) : null;
    if (machineFile) {
      const machineId = machines.authenticate(req.headers.authorization);
      const r = machineAttachment(attachments, machineId && store.machines.has(machineId) ? machineId : undefined, machineFile[1]);
      if ('error' in r) return send(res, r.status, { error: r.error });
      return sendStream(req, res, new StreamReply('application/octet-stream', r.file, r.record.size, downloadDisposition(r.record.name)));
    }
    // A machine's daemon sending a file its agent published as an attachment (docs/attachments.md, "Agents' files"): its
    // own token, only an upload the portal opened for that machine, chunks that resume, the SHA-256 checked at the end.
    const attachmentUpload = /^\/machine\/attachments\/uploads\/([a-f0-9]{32})$/.exec(url.pathname);
    if (attachmentUpload) {
      const machineId = machines.authenticate(req.headers.authorization);
      return await machineUploadHttp(attachments, machineId && store.machines.has(machineId) ? machineId : undefined, req, res, attachmentUpload[1], Number(url.searchParams.get('offset') ?? 0));
    }
    // A machine's daemon sending review media its agent published (docs/review.md): its own token, chunks that resume.
    const reviewUpload = /^\/machine\/review\/(rv_[a-f0-9]{24})$/.exec(url.pathname);
    if (reviewUpload) {
      const machineId = machines.authenticate(req.headers.authorization);
      return await reviewHttp(review, machineId && store.machines.has(machineId) ? machineId : undefined, req, res, reviewUpload[1], Number(url.searchParams.get('offset') ?? 0));
    }
    // A worker install setting up the portal's ssh (w568, server/machineSshHttp.ts): its own token, nothing else.
    if (url.pathname === '/machine/ssh') {
      const { run } = await import('./proc.ts');
      return await machineSshHttp(
        {
          machineOf: (h) => {
            const id = machines.authenticate(h);
            return id && store.machines.has(id) ? id : undefined;
          },
          publicKey: () => portalPublicKey(),
          tailnetAddress: () => tailnetAddress(run),
          register: (id, ssh) => machines.registerSsh(id, ssh),
          refused: () => (dryRun() ? DRY_RUN_WHY : undefined),
        },
        req,
        res,
      );
    }
    // A worker install asking about itself, or leaving (w513, docs/worker-install.md): its own token, nothing else.
    if (url.pathname === '/machine/whoami' || url.pathname === '/machine/unenroll' || url.pathname === '/machine/stopping') {
      const machineId = machines.authenticate(req.headers.authorization);
      if (!machineId || !store.machines.has(machineId)) return send(res, 401, { error: 'a valid machine token is required' });
      if (url.pathname === '/machine/whoami' && req.method === 'GET') return send(res, 200, machines.selfStatus(machineId));
      if (url.pathname === '/machine/stopping' && req.method === 'POST') return send(res, 200, machines.stoppingOnPurpose(machineId));
      if (url.pathname === '/machine/unenroll' && req.method === 'POST') {
        const r = machines.unenroll(machineId, url.searchParams.get('force') === '1');
        return send(res, r.ok ? 200 : 409, r);
      }
      return send(res, 405, { error: 'GET /machine/whoami, POST /machine/stopping or POST /machine/unenroll' });
    }
    // The nightly e2e lab's report (docs/intake.md, "Nightly e2e regressions"): a key minted --scope nightly, nothing else.
    if (url.pathname === '/api/intake/nightly' && req.method === 'POST') {
      const who = auth.bearer(req);
      if (!who.ok) return send(res, who.status, { error: who.status === 429 ? 'too many failures' : 'API key required' });
      if (who.scope !== 'nightly') return send(res, 403, { error: 'a nightly-scoped key is required (node server/apikey.ts <name> --scope nightly)' });
      const parsed = parseNightlyReport(await readJson(req, 256 * 1024));
      if ('error' in parsed) return send(res, 400, { error: parsed.error });
      // The nightly lab ran (and let go of its lab.lock): a lock blocker on it clears (w643).
      nightlyAt = Date.now();
      blockerWatch.kick();
      const results = intake.onNightly(parsed.report);
      if (!results) return send(res, 200, { enabled: false, note: 'the nightly intake is off (config intake.nightly.enabled)' });
      return send(res, 200, { enabled: true, results });
    }
    // Max's escalations from FFBox (docs/intake.md, "Escalations from Max"): a key minted --scope ffbox, nothing else.
    if (url.pathname === '/api/intake/ffbox' && req.method === 'POST') {
      const who = auth.bearer(req);
      if (!who.ok) return send(res, who.status, { error: who.status === 429 ? 'too many failures' : 'API key required' });
      if (who.scope !== 'ffbox') return send(res, 403, { error: 'an ffbox-scoped key is required (node server/apikey.ts <name> --scope ffbox)' });
      const parsed = parseEscalation(await readJson(req, 32 * 1024));
      if ('error' in parsed) return send(res, 400, { error: parsed.error });
      // w361: a finished intake diagnosis (source "intake"), else Max's escalation (w94).
      return send(res, 200, 'diagnosis' in parsed ? intake.onDiagnosis(parsed.diagnosis) : intake.onEscalation(parsed.escalation));
    }
    // Liveness and version, for scripts, monitors and the E2E harness. No login needed: the
    // version of an open-source app is public anyway.
    if (url.pathname === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, ...appNow(), ...(isDryRun ? { dryRun: true } : {}) });
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const { username, password } = await readJson<{ username?: string; password?: string }>(req);
      if (typeof username !== 'string' || typeof password !== 'string') return send(res, 400, { error: 'username and password required' });
      const r = await auth.login(req, username.trim(), password);
      return r.ok ? send(res, 200, { username: username.trim() }, { 'set-cookie': r.cookie }) : send(res, r.status, { error: r.error });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      return send(res, 200, {}, { 'set-cookie': auth.logout(req) });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!auth.user(req)) return send(res, 401, { error: 'login required' });
      for (const [method, re, h] of routes) {
        const m = req.method === method ? re.exec(url.pathname) : null;
        if (!m) continue;
        const out = await h(req, m.slice(1), url);
        if (out instanceof StreamReply) return sendStream(req, res, out);
        if (out instanceof FileReply) {
          res.writeHead(200, { 'content-type': out.type, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': FILE_CSP });
          return res.end(out.data);
        }
        return send(res, 200, out);
      }
      return send(res, 404, { error: 'no such endpoint' });
    }
    await serveStatic(WEB, req, url, res);
  } catch (e) {
    const status = e instanceof HttpError || e instanceof AttachmentError || e instanceof DispatcherChatRefused ? e.status : /^no (sandbox|session|standing agent|delegation|machine)/.test((e as Error).message) ? 404 : 400;
    // An upload that must resume elsewhere says where (docs/attachments.md).
    send(res, status, { error: (e as Error).message, ...(e instanceof AttachmentError && e.received !== undefined ? { received: e.received } : {}) });
  }
});

// Big messages (the full state a page gets when it connects, megabytes at thousands of sessions) go compressed;
// the stream of small events does not pay for zlib. No context takeover: no zlib memory kept per page between messages.
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 16 * 1024, serverNoContextTakeover: true, clientNoContextTakeover: true } });
/** Every page's socket, with the login it signed in as (notices meant for one person go to their pages only). */
const clients = new Map<WebSocket, string>();

server.on('upgrade', (req, socket, head) => {
  // Cross-site WebSocket hijacking: the page's own origin only. Compared as strings; parsing an
  // attacker-supplied Origin ("null", garbage) must never be able to throw.
  if (parseUrl(req.url)?.pathname === '/provider') {
    // FFBox's connector (docs/ffbox-connector-contract.md): its own token, no browser session.
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    const peer = req.socket.remoteAddress ?? '';
    providers.upgrade(req, socket, head, cfg.trustProxy && /^(::1|127\.|::ffff:127\.)/.test(peer) && fwd ? fwd : peer);
    return;
  }
  if (parseUrl(req.url)?.pathname === '/machine') {
    // A machine daemon (docs/machines.md): its own token, no browser session.
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    const peer = req.socket.remoteAddress ?? '';
    machines.upgrade(req, socket, head, cfg.trustProxy && /^(::1|127\.|::ffff:127\.)/.test(peer) && fwd ? fwd : peer);
    return;
  }
  const origin = req.headers.origin;
  const host = req.headers.host ?? '';
  const sameOrigin = !origin || origin === `https://${host}` || origin === `http://${host}`;
  if (parseUrl(req.url)?.pathname !== '/ws' || !auth.user(req) || !sameOrigin) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  const user = auth.user(req)!;
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.set(ws, user);
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    ws.on('close', () => clients.delete(ws));
    // A malformed frame (e.g. unmasked) emits 'error'; unhandled, that would kill the process.
    ws.on('error', (e) => {
      console.warn('websocket error:', e.message);
      clients.delete(ws);
    });
    ws.send(JSON.stringify({ type: 'state', state: appState(user) } satisfies ServerEvent));
  });
});

function sendStream(req: http.IncomingMessage, res: http.ServerResponse, f: StreamReply) {
  const headers = { 'content-type': f.type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': FILE_CSP, ...(f.disposition ? { 'content-disposition': f.disposition } : {}) };
  const range = parseRange(req.headers.range, f.size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${f.size}` });
    return res.end();
  }
  const { start, end } = range ?? { start: 0, end: f.size - 1 };
  res.writeHead(range ? 206 : 200, { ...headers, 'content-length': String(end - start + 1), ...(range ? { 'content-range': `bytes ${start}-${end}/${f.size}` } : {}) });
  if (f.size === 0) return res.end();
  const stream = fs.createReadStream(f.path, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// Sockets die silently (a laptop asleep, a phone suspending the tab, a NAT or proxy dropping an idle
// connection): no close ever arrives, so neither side would notice. Every SOCKET_PING_MS the server
// drops the sockets that did not answer the last protocol ping, and sends each page a 'ping' event it
// can see (browsers hide protocol pings), so a page that hears nothing knows to reconnect and refetch.
const alive = new WeakSet<WebSocket>();
setInterval(() => {
  for (const c of clients.keys()) {
    if (!alive.has(c)) {
      clients.delete(c);
      c.terminate();
      continue;
    }
    alive.delete(c);
    c.ping();
  }
  broadcast({ type: 'ping' });
}, SOCKET_PING_MS);

/**
 * The host status as one person's page gets it (w747): a Claude token pool banner (`person` set) only to the pool's own
 * person, so Ben never sees lothsahn's and lothsahn never sees Ben's; banners about the whole system (the dispatcher's
 * reserve, no `person`) go to everyone who is logged in, as before.
 */
function hostForUser(h: HostStatus, user: string): HostStatus {
  if (!h.tokenWarnings) return h;
  return { ...h, tokenWarnings: warningsForUser(h.tokenWarnings, user) };
}
function broadcast(e: ServerEvent) {
  if (e.type === 'host') {
    for (const [c, user] of clients) if (c.readyState === c.OPEN) c.send(JSON.stringify({ ...e, host: hostForUser(e.host, user) } satisfies ServerEvent));
    return;
  }
  const data = JSON.stringify(e);
  // A notice for some people only reaches their pages (docs/orchestrators.md: no interruptions).
  const only = e.type === 'notify' && e.users ? new Set(e.users.map((u) => u.toLowerCase())) : undefined;
  for (const [c, user] of clients) if (c.readyState === c.OPEN && (!only || only.has(user.toLowerCase()))) c.send(data);
}
bus.on('event', broadcast);
// A removed session's own temp folder goes with it (docs/self-recovery.md "Per-agent hygiene").
bus.on('event', (e: ServerEvent) => {
  if (e.type === 'session_removed') void fs.promises.rm(sessionTempDir(os.tmpdir(), e.id), { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
});
// The images an agent's message shows are copied into the transcript's store as it arrives (server/inlineImages.ts).
bus.on('event', (e: ServerEvent) => {
  if (e.type !== 'transcript' || e.event.kind !== 'assistant' || e.event.images) return;
  const { sessionId, event } = e;
  void keepMessageImages(store, sessionId, event, (file) => readImageIn(sessionImageRoots(sessionId, file), file)).catch(() => undefined);
});

setInterval(() => {
  try {
    agents.standing.tick();
  } catch (e) {
    console.error('standing agents tick:', e);
  }
}, 10_000);
async function refreshSystem() {
  try {
    lastSystem = await systemStats(cfg);
    broadcast({ type: 'system', system: lastSystem });
  } catch (e) {
    console.error('system stats:', e);
  }
}
void refreshSystem();
setInterval(refreshSystem, 5000);

wss.on('error', (e) => console.warn('websocket server error:', e.message));
server.on('clientError', (_e, socket) => socket.destroy());
// Failing to listen (port taken) is fatal, not something to "keep running" through: exit, and let
// the supervisor retry, instead of idling as a server that serves nothing.
server.on('error', (e) => {
  console.error('server error, exiting:', e);
  process.exit(1);
});

// Last line of defence: one bad request or a transient file lock must not take down every running
// agent. Log it loudly and keep serving.
process.on('uncaughtException', (e) => console.error('UNCAUGHT (kept running):', e));
process.on('unhandledRejection', (e) => console.error('UNHANDLED REJECTION (kept running):', e));

server.listen(cfg.port, cfg.host, () => {
  console.log(`FF Factory ${formatVersion(appVersion())} on http://${cfg.host}:${cfg.port} — base clone ${cfg.repo.basePath}; sandboxes are the machines' (w510)`);
});

/** This app's git HEAD, to tell the orchestrator what an update or restart changed. */
function appHead(): string | undefined {
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

let stopping = false;
/**
 * Stop the server cleanly: record which sessions to resume (data/resume.json), stop the agent
 * processes, save state, exit. For request_app_update also leave data/update.request, so the
 * supervisor updates before starting the next server.
 */
function stopServer(req: RestartRequest, drained: ReadonlySet<string> = new Set()) {
  if (stopping) return;
  stopping = true;
  console.log(`stopping (${req.reason}): stopping the portal's agent processes (the machines' agents and editors are their daemons')`);
  try {
    const f = agents.resumeFile(req, drained, appHead());
    writeResumeFile(cfg.dataDir, f);
    console.log(`recorded ${f.sessions.length} session(s) to resume: ${f.sessions.map((e) => `${e.id} (${e.why})`).join(', ') || 'none'}`);
  } catch (e) {
    console.error('could not write data/resume.json:', e);
  }
  if (req.update && !req.hold) fs.writeFileSync(path.join(cfg.dataDir, 'update.request'), new Date().toISOString());
  // The supervisor has it now (or it was not an update): nothing left to retry after a crash.
  clearPendingRestart(cfg.dataDir);
  // Backlog step 2 (config machines.keepAgentsOnRestart, docs/beast-machine.md): the daemons' agents carry on.
  sessions.stopAll((s) => !(keepDaemonAgents() && s.info.machineId));
  voice.unload('server stopping');
  providers.close();
  max.close();
  intake.close();
  ledgerSweep.close();
  blockerWatch.close();
  store.flush();
  process.exit(0);
}

// The user's Claude plan usage (server/usage.ts): polled at startup, then every config usagePollMinutes (default 15).
// Every account in use: this host's login and token here, each Mac's own login reported by its daemon.
const usage = new UsageTracker(cfg, () => {
  if (usage.usage) broadcast({ type: 'usage', usage: usage.usage });
  broadcast({ type: 'accounts', accounts: accountsNow() });
});
/** People's own Claude tokens (config userClaudeEnv, docs/identity.md), labelled with their names. */
function personTokens() {
  return identity
    .list()
    .map((u) => ({ u, token: userToken(cfg, u.userId) }))
    .filter((x): x is { u: (typeof x)['u']; token: string } => !!x.token)
    .map(({ u, token }) => ({ token, displayName: u.displayName, label: `${u.displayName}'s token …${token.slice(-4)}` }));
}
/** The token file's token (config claudeTokenFile, w464) while a role runs on it: polled by the meters like the others. */
function fileTokenEntry(): { token: string; label: string }[] {
  const t = tokenFileToken(cfg);
  return t ? [{ token: t, label: `token file …${t.slice(-4)}` }] : [];
}
// The vault's Claude tokens (docs/vault.md) are polled like the others: section 4 picks a run's token by these numbers.
usage.personTokens = () => [...personTokens(), ...fileTokenEntry(), ...vault.claudeTokens()];
/** Recent reasons a run did not get what the vault should give it (a fallback, an entry that would not open), newest last. */
const vaultProblems: { at: string; line: string }[] = [];
/** Live sessions whose process started on this credential key, not counting `except` (the asking session's own). */
const liveOnKey = (key: string, except?: string) => [...store.sessions.values()].filter((s) => s.id !== except && s.account === key && s.status !== 'stopped' && s.status !== 'error').length;
setVaultContext({
  vault,
  usageOf: (fp) => usage.entries.get(`token:${fp}`)?.usage,
  liveOn: (fp, except) => liveOnKey(`token:${fp}`, except),
  limits: () => poolLimits(cfg),
  payer: () => identity.systemPayer().userId,
  onProblem: (line) => {
    if (vaultProblems.at(-1)?.line !== line) console.warn(`vault: ${line}`);
    vaultProblems.push({ at: new Date().toISOString(), line });
    if (vaultProblems.length > 20) vaultProblems.shift();
  },
});
/**
 * The account a session ran on, for the meters. The dispatcher with an account of its own (claudeAccounts.dispatcher,
 * w464) runs on it, never on its person's own token, so its stopped session is counted there too.
 */
function sourceOf(s: SessionInfo, token: string | undefined, toMachine: (id: string) => string | undefined) {
  const role = hostRoleOf(cfg, s);
  const login = () => hostAccount(cfg, role) === 'login';
  // A person's orchestrator (or the ops worker for them) on "vault" (w738) ran on the pool token it was handed last; a
  // session with no pick (or one before a restart) on the token file it falls back to.
  if (s.kind !== 'worker' && !s.machineId && hostAccount(cfg, role) === 'vault') {
    const running = !!s.account && !!s.status && s.status !== 'stopped' && s.status !== 'error';
    const fp = running ? undefined : vault.lastPickOf(s.id);
    if (fp) return `token:${fp}`;
  }
  // A role on the token file (w464) ran on it, whoever the session was for.
  if (s.kind !== 'worker' && !s.machineId && (hostAccount(cfg, role) === 'tokenfile' || (hostAccount(cfg, role) === 'vault' && cfg.claudeTokenFile))) {
    const t = tokenFileToken(cfg);
    if (t) return sessionSource({ ...s, requestedBy: undefined }, t, toMachine, () => undefined, () => false);
  }
  if (role === 'dispatcher') return sessionSource({ ...s, requestedBy: undefined }, token, toMachine, () => undefined, login);
  return sessionSource(s, token, toMachine, (id) => userToken(cfg, id), (kind: SessionKind) => runsOnThisHost(kind) && hostAccount(cfg, hostRole(kind)) === 'login');
}
function accountSourceOf(s: SessionInfo) {
  const toMachine = (id: string) => machineToken(cfg, usesHostClaudeEnv(cfg, store.machines.get(id) ?? id));
  return sourceOf(s, hostToken(cfg), toMachine);
}
/** Whether the Claude account a session ran on has room again (no meter at 90% or more), or undefined when unknown (the ledger cleanup, before it resumes a worker a limit cut off). */
function limitsClearFor(s: SessionInfo): boolean | undefined {
  const source = accountSourceOf(s);
  const u = accountsNow().find((a) => a.sources.includes(source))?.usage;
  if (!u?.available) return undefined;
  return [u.weekly, u.session, ...u.models].filter((m): m is NonNullable<typeof m> => !!m).every((m) => m.percent < 90);
}
/** Whether the Claude account named by its email, label or id has room again (w643: a usage blocker), or undefined when unknown. */
function accountClear(name: string): boolean | undefined {
  const n = name.trim().toLowerCase();
  const u = accountsNow().find((a) => [a.id, a.label, a.email ?? ''].some((x) => x.toLowerCase() === n))?.usage;
  if (!u?.available) return undefined;
  return [u.weekly, u.session, ...u.models].filter((m): m is NonNullable<typeof m> => !!m).every((m) => m.percent < 90);
}
function accountsNow() {
  const token = hostToken(cfg);
  const toMachine = (id: string) => machineToken(cfg, usesHostClaudeEnv(cfg, store.machines.get(id) ?? id));
  const used = hostAccountsInUse(cfg);
  const machineList = machines.list().map((m) => {
    const t = toMachine(m.id);
    return { id: m.id, usesToken: !!t && !!token && tokenKey(t) === tokenKey(token), onVault: claudeFromVault(cfg, m) };
  });
  return buildAccounts(usage.entries, {
    hostName: os.hostname(),
    token: token ? { key: tokenKey(token), label: tokenLabel(token) } : undefined,
    hostLoginRoles: shownRoles(cfg).filter((r) => hostAccount(cfg, r) === 'login'),
    roles: shownRoles(cfg),
    ...(() => {
      const t = tokenFileToken(cfg);
      return t ? { tokenFile: { key: tokenKey(t), label: `token file …${t.slice(-4)}`, roles: shownRoles(cfg).filter((r) => hostAccount(cfg, r) === 'tokenfile') } } : {};
    })(),
    people: personTokens().map((p) => ({ key: tokenKey(p.token), label: p.label, displayName: p.displayName })),
    vault: vault.claudeTokens().map((v) => ({ key: `token:${v.fingerprint}`, label: v.label, ...(v.email ? { email: v.email } : {}) })),
    machines: machineList,
    inUse: {
      hostLogin: used.login || !token,
      hostToken: used.token || machineList.some((m) => m.usesToken),
      vault: used.vault || machineList.some((m) => m.onVault),
    },
    sessions: [...store.sessions.values()].map((s) => ({ id: s.id, source: sourceOf(s, token, toMachine), live: s.status !== 'stopped' && s.status !== 'error' })),
  });
}
// Which agents are on which account, and how many run now (the order), change with sessions and machines.
let accountShape = '';
let accountTimer: NodeJS.Timeout | undefined;
bus.on('event', (e: ServerEvent) => {
  if (!['session', 'session_removed', 'machine', 'machine_removed'].includes(e.type)) return;
  if (e.type === 'machine_removed') usage.forget(e.id);
  accountTimer ??= setTimeout(() => {
    accountTimer = undefined;
    const live = (s: { status: string }) => (s.status === 'stopped' || s.status === 'error' ? '' : '+');
    const shape = `${[...store.sessions.values()].map((s) => s.id + live(s) + (s.account ?? '')).join()}|${machines.list().map((m) => m.id).join()}|${hostToken(cfg)?.slice(-4) ?? ''}|${JSON.stringify([cfg.claudeAccounts, cfg.machines?.useHostClaudeEnv, cfg.machines?.claudeFromVault])}`;
    if (shape === accountShape) return;
    accountShape = shape;
    broadcast({ type: 'accounts', accounts: accountsNow() });
  }, 1000);
});
machines.onUsage = (id, account, u) => usage.report(id, account, u);
for (const s of sessions.sessions.values()) usage.recordCost(s.info.id, s.info.costUsd); // baselines
sessions.events.on('result', (s: { info: { id: string; costUsd: number } }) => usage.recordCost(s.info.id, s.info.costUsd));
// The SDK's rate_limit_event (the API's rate-limit headers on the session's own requests) raises its token's meter between polls (w739).
sessions.events.on('rateLimit', (s: { info: { account?: string } }, info: { rateLimitType?: string; utilization?: number; resetsAt?: number }) => usage.noteRateLimit(s.info.account, info));
/** Whose account each orchestrator runs on (docs/orchestrators.md), for system_status: a person without a token of their own is on the owner's. */
function orchestratorAccountsLine() {
  const people = identity.list();
  const own = people.filter((u) => userToken(cfg, u.userId)).map((u) => u.displayName);
  const none = people.filter((u) => !userToken(cfg, u.userId)).map((u) => u.displayName);
  const payer = identity.systemPayer();
  return (
    `Orchestrators: each person's own runs on their own token${own.length ? ` (${own.join(', ')})` : ''}` +
    `${none.length ? `; ${none.join(', ')} ${none.length === 1 ? 'has' : 'have'} none here, so theirs runs on the orchestrator's account above` : ''}` +
    `; the dispatcher runs for the system payer, ${payer.displayName}, on ${userToken(cfg, payer.userId) ? 'their own token' : "the orchestrator's account above"}.`
  );
}
agents.usageLines = () => {
  // Numbers under one interval old are used as they are; older, a poll starts (docs/accounts.md, "How often").
  usage.ensureFresh();
  return [
    ...accountSetupLines(cfg, os.hostname(), hostToken(cfg), machines.list(), personTokens().map((p) => p.displayName)),
    orchestratorAccountsLine(),
    ...accountLines(accountsNow(), store.sessions, new Date()),
  ];
};
// usagePollMinutes changed (set_app_config): this host's next poll moves, and the daemons hear the new interval.
agents.usagePollChanged = () => {
  usage.reschedule();
  machines.pushUsageConfig();
};
agents.machineStatusLines = () => machines.list().map((m) => machineLoadLine(m, machines.statsOf(m.id), machines.isOnline(m.id), machines.protocolOf(m.id)));
agents.extraStatusLines = () => {
  const ffbox = providers.statusLine();
  return [...(ffbox ? [ffbox] : []), max.statusLine(), ...outsideWatchLines(), ...pathHealth.statusLines(), ...unitWatchdog.statusLines(), ...vaultLines(), ...tokenReport().lines, ...(retiredKeys ? [retiredKeys] : [])];
};
/** The vault's summary for system_status, and its fallbacks in the last 24 hours (docs/vault.md). Never a value. */
const vaultLines = () => {
  const line = vaultStatusLine(vault, machines.list().filter((m) => claudeFromVault(cfg, m)).map((m) => m.id));
  const recent = vaultProblems.filter((p) => Date.now() - Date.parse(p.at) < 24 * 3_600_000);
  return [...(line ? [line] : []), ...(recent.length ? [`WARNING: the vault fell short ${recent.length} time(s) in 24 h; latest (${recent.at(-1)!.at}): ${recent.at(-1)!.line}`] : [])];
};
/**
 * Each person's Claude token pool as the rules read it now, and the dispatcher's (and host token's) reserve (w739,
 * docs/vault.md section 4): system_status lines and the dashboard's warnings. Only names, last four characters and numbers.
 */
function tokenReport(now = Date.now()): { lines: string[]; warnings: TokenWarning[] } {
  const usageOfKey = (key: string) => usage.entries.get(key)?.usage;
  const titlesOn = (key: string) => [...store.sessions.values()].filter((s) => s.account === key && s.status !== 'stopped' && s.status !== 'error').map((s) => s.title);
  const pools = vault.pools({ usageOf: (fp) => usageOfKey(`token:${fp}`), liveOn: (fp, except) => liveOnKey(`token:${fp}`, except), limits: () => poolLimits(cfg), now: () => now });
  const lines: string[] = [];
  const warnings: TokenWarning[] = [];
  for (const [person, list] of [...pools].sort((a, b) => a[0].localeCompare(b[0]))) {
    const each = list.map((t) => {
      const on = titlesOn(`token:${t.entry.fingerprint}`);
      return `${t.entry.name} …${t.entry.last4} ${t.view.state} (${t.view.why}${t.view.weeklyResetsAt ? `; weekly resets ${clock(t.view.weeklyResetsAt)}` : ''}${on.length ? `; ${on.length} running: ${on.slice(0, 3).join(', ')}${on.length > 3 ? ', …' : ''}` : ''})`;
    });
    const views = list.map((t) => t.view);
    const kind = poolKind(views);
    const next = firstFree(views);
    const vaultOrch = hostAccount(cfg, 'orchestrator') === 'vault';
    // The same words as the queue's reason and the banner (w747): "over its caps" only when every token is held, retired or used up.
    const verdict =
      kind === 'used-up'
        ? `every token is used up: ${person}'s new work waits until ${clock(next)}${vaultOrch ? ' and their orchestrator is stopped' : ''}`
        : kind === 'over'
          ? `every token is at a limit: ${person}'s new work waits until ${clock(next)}${vaultOrch ? '; their orchestrator uses the pool up (the token with the most room)' : ''}`
          : kind === 'slot-taken'
            ? `no token is free for a new job right now (the ones that still work are busy with their one job): a new job starts when the running one finishes${next ? `, or when a limit lifts ${clock(next)}` : ''}`
            : 'workers and agents served';
    lines.push(`Claude token pool, ${person} (${list.length} token${list.length === 1 ? '' : 's'}, soonest weekly reset first; caps ${poolLimits(cfg).sessionHold}% 5-hour / ${poolLimits(cfg).onePerWeekly}% one at a time / ${poolLimits(cfg).retireWeekly}% retired): ${each.join('; ')}. ${verdict}`);
    const banner = poolBanner(list.map((t) => ({ name: t.entry.name, last4: t.entry.last4, view: t.view })), 'your', vaultOrch);
    // For this person's own pages only (broadcast and appState filter on `person`): nobody else's top banner shows it.
    if (banner) warnings.push({ id: `pool:${person}`, kind: banner.kind, person, text: banner.text });
  }
  const others = (key: string, role: 'dispatcher' | 'host-token') =>
    role === 'dispatcher' ? [...store.sessions.values()].filter((s) => s.account === key && s.status !== 'stopped' && s.status !== 'error' && !(s.kind === 'orchestrator' && s.orchestratorRole === 'dispatcher')).length : 0;
  for (const r of reserveLines(cfg, usageOfKey, others, now)) {
    lines.push(r.line);
    if (r.warning) warnings.push({ id: `reserve:${r.cred.key}`, kind: 'reserve', text: r.warning });
  }
  return { lines, warnings };
}
let tokenWarningsShown = '';
/** The dashboard's token banners follow the meters and the sessions: refreshed on a timer, broadcast when they change. */
function refreshTokenWarnings() {
  const w = tokenReport().warnings;
  const sig = JSON.stringify(w);
  if (sig === tokenWarningsShown) return;
  tokenWarningsShown = sig;
  host.tokenWarnings = w.length ? w : undefined;
  broadcast({ type: 'host', host: { ...host, drain: drainer.status } });
}
setInterval(refreshTokenWarnings, 20_000).unref();
setTimeout(refreshTokenWarnings, 8_000).unref();
const outsideWatchLines = () => {
  const w = watcher();
  const c = watchConfig();
  if (!w || !c) return [`Outside watchdog: off (${isDryRun ? 'a dry run' : cfg.outsideWatch?.enabled === false ? 'outsideWatch.enabled is false' : !c ? 'no publicUrl to watch' : 'no machine to watch from'})`];
  return [
    `Outside watchdog: ${w} checks ${c.healthUrl} and pings ${c.host} every 60 s${machines.isOnline(w) ? '' : ` (${w} is offline now)`}; alerts go to ntfy topic "${c.ntfyTopic}" (subscribe in the ntfy app); Wake-on-LAN ${c.mac ? `to ${c.mac}${c.broadcast ? ` via ${c.broadcast}` : ''}` : 'not possible yet (MAC unknown)'}`,
  ];
};
usage.start();

/** Backlog step 2: a restart leaves the agents machine daemons run alone (config machines.keepAgentsOnRestart). */
const keepDaemonAgents = () => cfg.machines?.keepAgentsOnRestart === true;
const drainer = new Drainer({
  dataDir: cfg.dataDir,
  // With keepAgentsOnRestart the daemons' agents are not asked to wrap up: the restart does not stop them.
  snapshot: () => [...sessions.sessions.values()].filter((s) => !(keepDaemonAgents() && s.info.machineId)).map(snapshotOf),
  tell: (id, text) => void sessions.send(id, text, 'system'),
  stop: (req, drained) => stopServer(req, drained),
  changed: () => broadcast({ type: 'host', host: { ...host, drain: drainer.status } }),
  log: (line) => console.log(line),
  // The cut-over (w499, docs/portal-on-ffbox-host.md 7.3): restart.request's relocate sends the daemons to the new portal.
  relocate: (url) => machines.relocateAll(url),
});
agents.requestRestart = (req) => {
  // An update survives a power cut or a crash during the drain: the next server retries it (below).
  if (!drainer.status) writePendingRestart(cfg.dataDir, req);
  const note = drainer.request(req);
  broadcast({ type: 'host', host: { ...host, drain: drainer.status } });
  return note;
};

const plainStop = (reason: string): RestartRequest => ({ drain: false, drainMinutes: 0, reason, update: false, hold: false });
process.on('SIGINT', () => stopServer(plainStop('interrupted (SIGINT)')));
process.on('SIGTERM', () => stopServer(plainStop('terminated (SIGTERM)')));
// Windows has no SIGTERM for a detached process; the scripts ask for a stop with this file. Empty: stop
// now. JSON: drain first (scripts/restart.ps1; see server/restart.ts parseRestartRequest).
const restartFlag = path.join(cfg.dataDir, 'restart.request');
fs.rmSync(restartFlag, { force: true });
fs.rmSync(path.join(cfg.dataDir, 'drain.done'), { force: true });
setInterval(() => {
  if (!fs.existsSync(restartFlag)) return;
  let text = '';
  try {
    text = fs.readFileSync(restartFlag, 'utf8');
  } catch {
    // being written; next tick
    return;
  }
  fs.rmSync(restartFlag, { force: true });
  const req = parseRestartRequest(text);
  if (req === 'now') drainer.stopNow(plainStop('restart'));
  else agents.requestRestart!(req);
}, 1000);

// Local scripts that outlive a restart (scripts/republish-public.ps1) report to the orchestrator by dropping a
// text file in data/orchestrator-inbox; each is sent once as a system message, then renamed *.sent.
const inbox = path.join(cfg.dataDir, 'orchestrator-inbox');
setInterval(() => {
  const id = store.orchestratorId;
  // A dry run leaves the copied inbox alone: those notes are the real portal's.
  if (!id || isDryRun || !fs.existsSync(inbox)) return;
  for (const name of fs.readdirSync(inbox).filter((n) => n.endsWith('.txt')).sort()) {
    const file = path.join(inbox, name);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
      fs.renameSync(file, file.replace(/\.txt$/, '.sent'));
    } catch {
      continue; // being written; next tick
    }
    if (text) {
      try {
        sessions.send(id, text.slice(0, 8000), 'system');
      } catch (e) {
        console.warn(`orchestrator inbox: could not deliver ${name}: ${(e as Error).message}`);
      }
    }
  }
}, 5000);

/** The managers, for the E2E harness (e2e/server.ts) to set up states no browser can reach (a blocked editor). */
export const internals = { cfg, store, sessions, machines, agents, providers, max };

// Data files a crash damaged and that were restored from an earlier version (server/durable.ts). The owner hears at
// once (a push and their own orchestrator); the restart summary carries the same lines to the dispatcher.
let recoveriesTold = 0;
function takeRecoveryLines(): string[] {
  const fresh = dataRecoveries.slice(recoveriesTold);
  recoveriesTold = dataRecoveries.length;
  return fresh.map(describeRecovery);
}
function tellOwnerRecovered(text: string) {
  // A dry run tells nobody (no push, no orchestrator): the log has it, where the migration's check reads it.
  if (isDryRun) return void console.warn(`dry run: ${text}`);
  notifier.host('Data restored after a crash', text);
  if (!cfg.orchestrator.notifyOnWorkerEvents) return;
  try {
    agents.orchestrators.toPeople([identity.owner()], `[data restored] ${text}`);
  } catch (e) {
    console.warn(`could not tell the owner about the data recovery: ${(e as Error).message}`);
  }
}
// A file read on demand (users.json, api-keys.json, machine-tokens.json) can be healed later: the dispatcher hears too.
setInterval(() => {
  const lines = takeRecoveryLines();
  if (!lines.length) return;
  const text = `DATA RESTORED: ${lines.join(' ')}`;
  tellOwnerRecovered(text);
  if (isDryRun) return;
  const orch = store.orchestratorId;
  if (orch) {
    try {
      sessions.send(orch, `[data restored] ${text}`, 'system');
    } catch {
      // no orchestrator right now; the push went out
    }
  }
}, 60_000).unref();

// Resume what the last server recorded (or report what a crash cut off), once the managers are up.
// After a stop that was not clean (no resume file: a power cut, a crash, a kill), make one from what the last
// server left (the sessions it had mid-turn, the editors that were up) and resume those too; an update that
// was pending then is retried first (docs/restart.md).
setTimeout(() => {
  try {
    if (isDryRun) {
      // A dry run resumes nothing, retries no update and leaves the copied resume files as they are.
      const recovered = takeRecoveryLines();
      if (recovered.length) tellOwnerRecovered(`DATA RESTORED AFTER A CRASH: ${recovered.join(' ')}`);
      console.log('dry run: nothing resumed after the start (no restart note to anyone, no resumes, no pending update)');
      return;
    }
    const notes = host.elevated ? [`WARNING: the server is running elevated, so every orchestrator shell inherits admin rights: ${host.elevatedWhy ?? ''}`] : [];
    const recovered = takeRecoveryLines();
    if (recovered.length) {
      const text = `DATA RESTORED AFTER A CRASH (the last server was last alive ${lastAlive ? new Date(lastAlive.at).toISOString() : 'at an unknown time'}): ${recovered.join(' ')}`;
      notes.push(text);
      tellOwnerRecovered(text);
    }
    const clean = takeResumeFile(cfg.dataDir);
    const pending = takePendingRestart(cfg.dataDir);
    if (clean) {
      agents.resumeAfterRestart(clean, cutOff, { head: appHead(), version: appVersion().version }, notes);
      return;
    }
    const cause = describeUncleanStop({ lastAliveAt: lastAlive?.at, bootAt: Date.now() - os.uptime() * 1000, host: os.hostname() });
    if (!mayRecoverUnclean(cfg.dataDir)) {
      // A second unclean stop within 30 minutes: maybe a crash loop. Report only, as before.
      notes.push(`Cause: ${cause}. This is the second unclean stop within 30 minutes, so nothing was resumed or restarted automatically (crash-loop guard)${pending ? `, and the pending update (${pending.reason}) was not retried` : ''}.`);
      agents.resumeAfterRestart(undefined, cutOff, { head: appHead(), version: appVersion().version }, notes);
      return;
    }
    const f = agents.uncleanResumeFile(cutOff, cause, lastAlive?.at, appHead());
    console.warn(`unclean stop: ${cause}; ${f.sessions.length} session(s) to bring back${pending ? `; retrying the pending update (${pending.reason})` : ''}`);
    if (pending && !host.elevated) {
      // Hand it to the supervisor as a clean update would, with everything to bring back in the resume file.
      writeResumeFile(cfg.dataDir, { ...f, reason: pending.reason, update: true });
      fs.writeFileSync(path.join(cfg.dataDir, 'update.request'), new Date().toISOString());
      store.flush();
      process.exit(0);
    }
    agents.resumeAfterRestart(f, cutOff, { head: appHead(), version: appVersion().version }, notes);
  } catch (e) {
    console.error('resume after restart:', e);
  }
}, 2000);
