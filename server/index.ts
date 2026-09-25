import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, ROOT } from './config.ts';
import { Store, bus } from './store.ts';
import { SandboxManager } from './sandboxes.ts';
import { SessionManager, snapshotOf } from './sessions.ts';
import { Agents } from './agents.ts';
import { MachineManager } from './machines.ts';
import { Notifier } from './notify.ts';
import { refreshSandboxGit } from './gitStatus.ts';
import { describeBusy } from './wake.ts';
import type { SessionHandle } from './sessions.ts';
import { systemStats } from './system.ts';
import { Auth } from './auth.ts';
import { handleMcp } from './mcp.ts';
import { IMAGE_TYPES, type ImageInput, type NotifyPrefs, type SendMessageRequest } from '../shared/types.ts';
import { listImages, MEDIA_TYPE, openVideo, parseRange, readImage, VIDEO_FILE } from './images.ts';
import { HostHealthMonitor } from './hostHealth.ts';
import { runHelper } from './privileged.ts';
import { planCleanup, runCleanup } from './cleanup.ts';
import { reapBrowsers } from './reaper.ts';
import { TASK_NAME, checkElevation } from './elevation.ts';
import { Drainer, clearPendingRestart, describeUncleanStop, mayRecoverUnclean, parseRestartRequest, readAlive, takePendingRestart, takeResumeFile, writeAlive, writePendingRestart, writeResumeFile, type RestartRequest } from './restart.ts';
import { UsageTracker, usageLines } from './usage.ts';
import { appVersion, formatVersion } from './version.ts';
import { VoiceService } from './voice.ts';
import { MAX_DICTATION_SECONDS, MAX_TTS_CHARS, buildVoicePrompt, wavSeconds, type SpeakRequest, type TranscribeRequest, type VocabularySource } from '../shared/voice.ts';
import type { AppState, CreateSandboxRequest, HostStatus, PermissionDecisionRequest, ServerEvent, StandingAgentInput, StartSessionRequest, SystemStats } from '../shared/types.ts';

const cfg = loadConfig();
fs.mkdirSync(cfg.dataDir, { recursive: true });

// First of all, before anything is started: never run elevated (server/elevation.ts). Everything this
// server starts inherits its token, and an elevated Unity editor stops on a modal admin dialog.
const elevation = await checkElevation(cfg.dataDir);
if (elevation === 'exit') {
  console.log(`Running elevated: handed off to the Limited ${TASK_NAME} task (scripts/restart.ps1 relaunches the app non-elevated). Exiting.`);
  process.exit(0);
}
const host: HostStatus = { elevated: elevation.elevated, elevatedWhy: elevation.why };
if (host.elevated) {
  console.error(
    `\n!!!!!!!! FF Factory is running WITH ADMINISTRATOR RIGHTS. It will not start Unity editors (they would stop on Unity's administrator dialog), ` +
      `and every agent shell inherits admin rights. ${host.elevatedWhy ?? ''} Fix: run scripts/restart.ps1 (from any shell).\n`,
  );
}

// When the last server was last alive (its heartbeat), read before this one beats: after an unclean stop it
// dates the outage and tells a power cut (the machine booted since) from a server crash.
const lastAlive = readAlive(cfg.dataDir);
writeAlive(cfg.dataDir);
setInterval(() => writeAlive(cfg.dataDir), 30_000);

const store = new Store(cfg.dataDir);
const sandboxes = new SandboxManager(cfg, store);
const sessions = new SessionManager(cfg, store);
const machines = new MachineManager(cfg, store, sessions);
// A daemon that has not come back 2 minutes after a restart (or a drop) while ssh reaches its Mac is redeployed.
// The machines' own Unity watch: tell the orchestrator and the user, and the machine's agents after a restart.
machines.unityEvent = (machineId, text, restarted) => {
  const line = `[unity] machine ${machineId}: ${text}`;
  console.log(line);
  notifier.host(`Unity on ${machineId}${restarted ? ' restarted' : ''}`, text);
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
    if (s.machineId !== machineId || s.kind === 'standing') continue;
    if (!['running', 'starting', 'waiting_permission'].includes(s.status) && Date.parse(s.lastActivityAt) < recent) continue;
    try {
      sessions.send(s.id, `Unity on this machine was restarted automatically at ${new Date().toLocaleTimeString()} (${text.split(';')[0]}). Re-pin it (mcpforunity://instances, then set_active_instance) once its bridge is up, and continue where you left off.`, 'system');
    } catch {
      // offline or at its limit: it sees the editor state on its next Unity call
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
setInterval(() => {
  void machines.watchOffline().catch((e) => console.warn('machine watchdog:', (e as Error).message));
  machines.checkOutdated();
}, 30_000);
const agents = new Agents(cfg, store, sandboxes, sessions, machines);
if (host.elevated) sandboxes.refuseUnityWhileElevated(host.elevatedWhy ?? 'Run scripts/restart.ps1 to relaunch it non-elevated.');
const auth = new Auth(cfg.dataDir, { trustProxy: cfg.trustProxy });
const notifier = new Notifier(cfg.dataDir, store, sessions);
notifier.orchestratorId = () => store.orchestratorId;
agents.standing.events.on('run', (a, run) => notifier.standingRun(a, run));
agents.standing.events.on('delegation', (d) => notifier.delegation(d));
agents.standing.events.on('delegationUpdate', (d, what) => notifier.delegationUpdate(d, what));
sandboxes.events.on('blocked', (sb, b) => notifier.unityBlocked(sb, b));

// Automatic editor restarts (docs/unity-lifecycle.md): a [unity] notice, and once the editor is back up, a
// message to the sandbox's agents to re-pin and carry on.
sandboxes.events.on('unityRestart', (sb, r) => {
  const at = new Date().toLocaleTimeString();
  const text = r.gaveUp
    ? `automatic restart ${r.error ? `failed (${r.error})` : `stopped: ${cfg.unity.autoRestart.max} in ${cfg.unity.autoRestart.windowMinutes} min already`}; ${r.why}. Look at it, then restart it with the unity tool.`
    : `restarted at ${at} after ${r.why}`;
  const line = `[unity] ${sb.name} (${sb.id}): ${text}`;
  console.log(line);
  if (!r.gaveUp || r.error) notifier.host(`Unity in ${sb.name} ${r.gaveUp ? 'needs a person' : 'restarted'}`, text); // a give-up is also a 'blocked' notice
  const orch = store.orchestratorId;
  if (orch) {
    try {
      sessions.send(orch, line, 'system');
    } catch {
      // no orchestrator right now
    }
  }
  if (r.gaveUp) return;
  const deadline = Date.now() + 30 * 60_000;
  const tell = () => {
    const cur = store.sandboxes.get(sb.id);
    if (!cur || cur.unity.state === 'stopped' || cur.unity.state === 'crashed' || Date.now() > deadline) return;
    if (cur.unity.state !== 'running') return void setTimeout(tell, 15_000);
    const recent = Date.now() - 30 * 60_000;
    for (const s of store.sessions.values()) {
      if (s.sandboxId !== sb.id || s.kind === 'standing') continue;
      if (!['running', 'starting', 'waiting_permission'].includes(s.status) && Date.parse(s.lastActivityAt) < recent) continue;
      try {
        sessions.send(s.id, `Unity was restarted after a hang/crash at ${at} (${r.why}). It is up again: re-pin (mcpforunity://instances, then set_active_instance) and continue.`, 'system');
      } catch {
        // offline or at its limit: it sees the editor state on its next Unity call
      }
    }
  };
  setTimeout(tell, 15_000);
});

// The host guard: disk space, the sandbox drive's self-recovery, RAM and idle editors (docs/self-recovery.md).
const hostHealth = new HostHealthMonitor({
  cfg,
  statfs: async (p) => {
    try {
      const s = await fs.promises.statfs(p);
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
    } catch {
      return undefined;
    }
  },
  exists: (p) => fs.existsSync(p),
  mem: () => ({ free: os.freemem(), total: os.totalmem() }),
  sandboxes: () => sandboxes.list(),
  sessions: () => [...store.sessions.values()],
  startEditor: async (id) => void (await sandboxes.startUnity(id)),
  stopEditor: async (id) => void (await sandboxes.stopUnity(id)),
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
  runHelper: (a) => runHelper(a),
  cleanup: async () => {
    const keep = [...cfg.protectedPaths, cfg.sandboxRoot, cfg.standingRoot, cfg.repo.basePath, ROOT, cfg.dataDir];
    const items = planCleanup({ policy: cfg.hostGuard.cleanup, keep });
    const logs = sandboxes.list().filter((s) => s.unity.logPath).map((s) => ({ logsDir: path.dirname(s.unity.logPath!), current: s.unity.logPath! }));
    const r = runCleanup(items, logs);
    return { removed: r.removed.length };
  },
  reap: (hours) => reapBrowsers(hours),
  changed: (h) => {
    host.health = h;
    broadcast({ type: 'host', host: { ...host, drain: drainer.status } });
  },
  log: (line) => console.warn(line),
});
sandboxes.startGate = () => hostHealth.blockReason('editor');
sessions.startGate = () => hostHealth.blockReason('agent');
agents.standing.hostGate = () => hostHealth.blockReason('agent');
agents.hostHealth = hostHealth;
if (cfg.hostGuard.pollSeconds > 0) {
  setInterval(() => void hostHealth.tick(), cfg.hostGuard.pollSeconds * 1000);
  setTimeout(() => void hostHealth.tick(), 5000);
}
if (!auth.hasUsers()) console.warn('No users yet. Create one on this machine: node server/user.ts <username>');
sandboxes.reconcile();
const cutOff = agents.boot();

let lastSystem: SystemStats | undefined;

function appState(): AppState {
  return {
    app: appVersion(),
    sandboxes: sandboxes.list(),
    sessions: [...store.sessions.values()],
    standingAgents: agents.standing.list(),
    delegations: [...store.delegations.values()],
    machines: machines.list(),
    system: lastSystem,
    host: { ...host, drain: drainer.status },
    usage: usage.usage,
    orchestratorId: agents.orchestratorId,
    config: { defaultModel: cfg.defaultModel, models: cfg.models, defaultBase: cfg.defaultBase },
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
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(json);
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

route('GET', '/api/state', async () => appState());
route('GET', '/api/me', async (req) => ({ username: auth.user(req) }));

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
  // Images come base64 in the JSON (the UI shrinks them first), so this body may be large.
  const { text, images } = await readJson<SendMessageRequest>(req, 40 * 1024 * 1024);
  const imgs = checkImages(images);
  const s = sessions.get(id);
  // A standing agent only works inside a run (budget, no overlap, agent limit): a message starts one.
  if (s.info.kind === 'standing' && s.info.standingId) {
    if (imgs.length) throw new HttpError(400, 'standing agents take text only; describe the image or put it in their folder');
    return { note: agents.standing.runNow(s.info.standingId, 'message', need(text, 'text')) };
  }
  if (!imgs.length) need(text, 'text');
  // The user wrote to the orchestrator: its own wake_me check-in is moot.
  if (id === store.orchestratorId) agents.waker.cancel(id);
  sessions.send(id, String(text ?? '').trim(), 'human', imgs);
  return {};
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
  constructor(type: string, file: string, size: number) {
    this.type = type;
    this.path = file;
    this.size = size;
  }
}

class FileReply {
  readonly type: string;
  readonly data: Buffer;
  constructor(type: string, data: Buffer) {
    this.type = type;
    this.data = data;
  }
}

route('GET', '/api/uploads/([\\w-]+)/([\\w-]+)', async (_r, [sessionId, imageId]) => {
  const f = store.imagePath(sessionId, imageId);
  if (!f) throw new HttpError(404, 'no such image');
  return new FileReply(MEDIA_TYPE[f.split('.').pop()!] ?? 'application/octet-stream', fs.readFileSync(f));
});

/**
 * Where a session, sandbox or machine may show images from. `machine` means: ask that machine's daemon.
 * The orchestrator oversees everything: the base clone, every sandbox and standing agent folder, and (for a
 * path under a machine's clone or home) that machine's own folders, which its daemon checks.
 */
function imageRoots(url: URL, file?: string): { machine?: string; roots: string[] } {
  const sessionId = url.searchParams.get('session');
  const sandboxId = url.searchParams.get('sandbox');
  const machineId = url.searchParams.get('machine');
  if (sandboxId) return { roots: [sandboxes.require(sandboxId).path] };
  if (machineId) return { machine: machines.require(machineId).id, roots: [] };
  if (!sessionId) throw new HttpError(400, 'give session, sandbox or machine');
  const s = sessions.get(sessionId).info;
  if (s.machineId) return { machine: s.machineId, roots: [] };
  if (s.sandboxId) return { roots: [sandboxes.require(s.sandboxId).path] };
  if (s.standingId) return { roots: [agents.standing.require(s.standingId).folder] };
  if (s.kind === 'orchestrator') {
    const onMac = file && file.startsWith('/') ? machines.list().find((m) => [m.repoPath, m.home].some((r) => r && (file === r || file.startsWith(r.replace(/\/+$/, '') + '/')))) : undefined;
    if (onMac) return { machine: onMac.id, roots: [] };
    return { roots: [cfg.repo.basePath, cfg.sandboxRoot, cfg.standingRoot] };
  }
  throw new HttpError(404, 'no folder for this session');
}

route('GET', '/api/image', async (_r, _p, url) => {
  const file = need(url.searchParams.get('path'), 'path');
  const where = imageRoots(url, file);
  try {
    if (VIDEO_FILE.test(file)) {
      if (where.machine) throw new Error('videos on a machine cannot be shown yet');
      const v = openVideo(file, where.roots);
      return new StreamReply(v.mediaType, v.path, v.size);
    }
    const img = where.machine ? await machines.readImage(where.machine, file) : readImage(file, where.roots);
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
  return { title: sessions.setTitle(id, need(title, 'title')) };
});

route('POST', '/api/sessions/([\\w-]+)/interrupt', async (_r, [id]) => {
  await sessions.get(id).interrupt();
  return {};
});

route('POST', '/api/sessions/([\\w-]+)/permission', async (req, [id]) => {
  const b = await readJson<PermissionDecisionRequest>(req);
  if (!sessions.get(id).decide(need(b.requestId, 'requestId'), !!b.allow, b.message)) throw new HttpError(404, 'no such pending request');
  return {};
});

route('POST', '/api/sessions/([\\w-]+)/mode', async (req, [id]) => {
  const { mode } = await readJson<{ mode: string }>(req);
  if (!['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto'].includes(mode)) throw new HttpError(400, 'bad mode');
  await sessions.get(id).setMode(mode as never);
  return {};
});

route('POST', '/api/sessions', async (req) => {
  const b = await readJson<StartSessionRequest>(req);
  const s = agents.startWorker({
    sandbox: b.sandboxId || undefined,
    machine: b.machineId || undefined,
    prompt: need(b.prompt, 'prompt'),
    title: b.title,
    model: b.model,
    permissionMode: b.permissionMode,
    effort: b.effort,
    from: 'human',
  });
  return s.info;
});

route('DELETE', '/api/sessions/([\\w-]+)', async (_r, [id]) => {
  const s = sessions.get(id);
  if (s.info.kind === 'orchestrator') throw new HttpError(400, 'reset the orchestrator instead');
  if (s.info.kind === 'standing') throw new HttpError(400, "this is a standing agent's conversation; delete the agent instead");
  const sb = s.info.sandboxId ? store.sandboxes.get(s.info.sandboxId) : undefined;
  sessions.remove(id);
  if (sb) {
    sb.sessionIds = sb.sessionIds.filter((x) => x !== id);
    store.putSandbox(sb);
  }
  return {};
});

route('POST', '/api/orchestrator/reset', async () => {
  agents.newOrchestrator();
  broadcast({ type: 'state', state: appState() });
  return {};
});

route('POST', '/api/sandboxes', async (req) => {
  const b = await readJson<CreateSandboxRequest>(req);
  need(b.name, 'name');
  return sandboxes.create(b);
});

route('DELETE', '/api/sandboxes/([\\w-]+)', async (_r, [id]) => {
  const sb = sandboxes.require(id);
  for (const sid of sb.sessionIds) if (sessions.sessions.has(sid)) sessions.remove(sid);
  void sandboxes.remove(id).catch((e) => console.error(`delete ${id}:`, e));
  return {};
});

route('POST', '/api/sandboxes/([\\w-]+)/unity', async (req, [id]) => {
  const { action } = await readJson<{ action: string }>(req);
  if (action === 'start') return sandboxes.startUnity(id);
  if (action === 'stop') return sandboxes.stopUnity(id);
  throw new HttpError(400, 'action must be start or stop');
});

route('GET', '/api/sandboxes/([\\w-]+)/unity-log', async (_r, [id], url) => ({
  lines: sandboxes.unityLog(id, Math.min(5000, Number(url.searchParams.get('lines')) || 200)),
}));

// ---- standing agents (docs/standing-agents.md)

route('POST', '/api/standing', async (req) => agents.standing.create(await readJson<StandingAgentInput>(req)));

route('POST', '/api/standing/([\\w-]+)', async (req, [id]) => agents.standing.update(id, await readJson<Partial<StandingAgentInput>>(req)));

route('DELETE', '/api/standing/([\\w-]+)', async (_r, [id]) => {
  agents.standing.remove(id);
  return {};
});

route('POST', '/api/standing/([\\w-]+)/(run|stop|pause|resume)', async (_r, [id, action]) => {
  const st = agents.standing;
  if (action === 'run') return { note: st.runNow(id, 'manual') };
  if (action === 'stop') return { note: st.stop(id) };
  return action === 'pause' ? st.pause(id) : st.resume(id);
});

route('POST', '/api/delegations/([\\w-]+)/(approve|reject)', async (req, [id, action]) => {
  if (action === 'approve') return agents.standing.approveDelegation(id);
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

route('POST', '/api/settings', async (req) => {
  const b = await readJson<{ heartbeatMinutes?: number | null }>(req);
  const m = b.heartbeatMinutes;
  if (m !== undefined && m !== null && (!Number.isInteger(m) || m < 5 || m > 240)) throw new HttpError(400, 'heartbeatMinutes: 5 to 240, or null for off');
  return store.putSettings({ ...(m !== undefined ? { heartbeatMinutes: m } : {}) });
});

setInterval(() => {
  agents.waker.heartbeat(store.orchestratorId, store.settings.heartbeatMinutes, (s) =>
    describeBusy(s, { sandbox: s.sandboxId ? store.sandboxes.get(s.sandboxId) : undefined, machine: s.machineId }),
  );
}, 60_000);

// ---- switch_branch (server/switchBranch.ts)

route('POST', '/api/(sandboxes|machines)/([\\w-]+)/switch-branch', async (req, [kind, id]) => {
  const b = await readJson<{ branch?: string; createFrom?: string }>(req);
  const target = kind === 'sandboxes' ? { sandbox: id } : { machine: id };
  return { note: await agents.switchBranch({ ...target, branch: need(b.branch, 'branch').trim(), createFrom: b.createFrom?.trim() || undefined }) };
});

// ---- machines (docs/machines.md)

route('POST', '/api/machines', async (req) => {
  const b = await readJson<{ id?: string; host?: string; portalUrl?: string; repoPath?: string; maxSessions?: number }>(req);
  return machines.deployMachine({ id: need(b.id, 'id'), host: b.host, portalUrl: b.portalUrl, repoPath: b.repoPath || undefined, maxSessions: b.maxSessions });
});

route('POST', '/api/machines/([\\w-]+)/redeploy', async (req, [id]) => {
  const b = await readJson<{ force?: boolean }>(req);
  return machines.deployMachine({ id, force: !!b.force });
});

route('POST', '/api/machines/([\\w-]+)/label', async (req, [id]) => {
  const { purpose } = await readJson<{ purpose?: string }>(req);
  return machines.setPurpose(id, need(purpose, 'purpose'));
});

route('DELETE', '/api/machines/([\\w-]+)', async (_r, [id]) => ({ note: await machines.removeMachine(id) }));

// ---- voice input (server/voice.ts, docs/voice.md)

const voice = new VoiceService(cfg, () => buildVoicePrompt(vocabulary()));
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
    sandboxes: sandboxes.list(),
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

// ------------------------------------------------------------------ static web app

const WEB = path.join(ROOT, 'web', 'dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(url: URL, res: http.ServerResponse) {
  let file = path.normalize(path.join(WEB, decodeURIComponent(url.pathname)));
  if (!file.startsWith(WEB)) return send(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('Web UI not built. Run: npm run build');
  }
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}

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
      return await handleMcp(agents, who.name, req, res, req.method === 'POST' ? await readJson(req) : undefined);
    }
    if (url.pathname.startsWith('/api/') && req.method !== 'GET') {
      // CSRF: a cross-site form cannot send application/json, and SameSite=Strict keeps the cookie home.
      if (req.method !== 'DELETE' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return send(res, 415, { error: 'JSON only' });
      }
    }
    // Liveness and version, for scripts, monitors and the E2E harness. No login needed: the
    // version of an open-source app is public anyway.
    if (url.pathname === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, ...appVersion() });
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
          res.writeHead(200, { 'content-type': out.type, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
          return res.end(out.data);
        }
        return send(res, 200, out);
      }
      return send(res, 404, { error: 'no such endpoint' });
    }
    serveStatic(url, res);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : /^no (sandbox|session|standing agent|delegation|machine)/.test((e as Error).message) ? 404 : 400;
    send(res, status, { error: (e as Error).message });
  }
});

const wss = new WebSocketServer({ noServer: true });
const clients = new Set<WebSocket>();

server.on('upgrade', (req, socket, head) => {
  // Cross-site WebSocket hijacking: the page's own origin only. Compared as strings; parsing an
  // attacker-supplied Origin ("null", garbage) must never be able to throw.
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
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    // A malformed frame (e.g. unmasked) emits 'error'; unhandled, that would kill the process.
    ws.on('error', (e) => {
      console.warn('websocket error:', e.message);
      clients.delete(ws);
    });
    ws.send(JSON.stringify({ type: 'state', state: appState() } satisfies ServerEvent));
  });
});

function sendStream(req: http.IncomingMessage, res: http.ServerResponse, f: StreamReply) {
  const headers = { 'content-type': f.type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" };
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

function broadcast(e: ServerEvent) {
  const data = JSON.stringify(e);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(data);
}
bus.on('event', broadcast);

setInterval(() => sandboxes.poll(), 3000);

// ---- git status per sandbox (server/gitStatus.ts): a light timer, plus right after an agent turn there.

const refreshGit = (id: string) => refreshSandboxGit(store, id);
setInterval(() => {
  for (const id of store.sandboxes.keys()) void refreshGit(id);
}, 60_000);
setTimeout(() => {
  for (const id of store.sandboxes.keys()) void refreshGit(id);
}, 2000);
sessions.events.on('turnEnd', (s: SessionHandle) => {
  if (s.info.sandboxId) setTimeout(() => void refreshGit(s.info.sandboxId!), 1500);
  if (s.info.machineId) machines.refreshGit(s.info.machineId);
});
bus.on('event', (e) => {
  // A sandbox that just finished provisioning.
  if (e.type === 'sandbox' && e.sandbox.status === 'ready' && !e.sandbox.git) void refreshGit(e.sandbox.id);
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
  console.log(`FF Factory ${formatVersion(appVersion())} on http://${cfg.host}:${cfg.port} — sandboxes in ${cfg.sandboxRoot}, base clone ${cfg.repo.basePath}`);
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
  console.log(`stopping (${req.reason}): stopping agent processes (Unity editors are left running)`);
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
  sessions.stopAll();
  voice.unload('server stopping');
  store.flush();
  process.exit(0);
}

// The user's Claude plan usage (server/usage.ts): refreshed every few minutes and after rate-limit events.
const usage = new UsageTracker(cfg, (u) => broadcast({ type: 'usage', usage: u }));
for (const s of sessions.sessions.values()) usage.recordCost(s.info.id, s.info.costUsd); // baselines
sessions.events.on('rateLimit', () => usage.poke());
sessions.events.on('result', (s: { info: { id: string; costUsd: number } }) => usage.recordCost(s.info.id, s.info.costUsd));
agents.usageLines = () => usageLines(usage.usage, new Date());
usage.start();

const drainer = new Drainer({
  dataDir: cfg.dataDir,
  snapshot: () => [...sessions.sessions.values()].map(snapshotOf),
  tell: (id, text) => void sessions.send(id, text, 'system'),
  stop: (req, drained) => stopServer(req, drained),
  changed: () => broadcast({ type: 'host', host: { ...host, drain: drainer.status } }),
  log: (line) => console.log(line),
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
  if (!id || !fs.existsSync(inbox)) return;
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
export const internals = { cfg, store, sandboxes, sessions, agents };

// Resume what the last server recorded (or report what a crash cut off), once the managers are up.
// After a stop that was not clean (no resume file: a power cut, a crash, a kill), make one from what the last
// server left (the sessions it had mid-turn, the editors that were up) and resume those too; an update that
// was pending then is retried first (docs/restart.md).
setTimeout(() => {
  try {
    const notes = host.elevated ? [`WARNING: the server is running elevated, so it will not start Unity editors: ${host.elevatedWhy ?? ''}`] : [];
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
    const f = agents.uncleanResumeFile(cutOff, cause, sandboxes.lostEditors, lastAlive?.at, appHead());
    console.warn(`unclean stop: ${cause}; ${f.sessions.length} session(s) and ${f.editors?.length ?? 0} editor(s) to bring back${pending ? `; retrying the pending update (${pending.reason})` : ''}`);
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
