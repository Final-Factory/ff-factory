// A mock FF Factory backend for working on the UI without Unity, Claude or a real host: the whole
// wire contract (shared/types.ts) over HTTP and /ws, backed by the scenario in ./scenario.ts, with
// simulated agent turns (streaming text, tool calls, permission prompts, interrupts). Not shipped.
//
//   npm --prefix web run build && npm --prefix web run mock     # serves web/dist and the API on :8790
//   npm --prefix web run dev                                     # or Vite on :5173 against it
//
// Sign in with any username and the password "mock" (MOCK_NOAUTH=1 skips the login).
// MOCK_SCENARIO=fresh starts empty (first run); MOCK_FROZEN=1 stops the meters moving (screenshots);
// MOCK_DIST serves another build (e.g. an old one, to compare).
// In any chat: a message containing "perm" asks for a permission, "slow" streams slowly, "fail" errors.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AppState, LiveKnob, LiveViewInfo, Machine, MachineSandbox, SearchHit, ServerEvent, SessionInfo, TranscriptEvent } from '../../shared/types.ts';
import { buildWorld, localMachine, type ImageKey, type Scenario } from './scenario.ts';
import { phoneShot, spaceScene } from './png.ts';
import { scaleWorld, startLiveTraffic } from './scale.ts';

const PORT = Number(process.env.PORT ?? 8790);
const NOAUTH = process.env.MOCK_NOAUTH === '1';
const FROZEN = process.env.MOCK_FROZEN === '1';
const SCENARIO = (process.env.MOCK_SCENARIO ?? 'busy') as Scenario;
const DIST = path.resolve(process.env.MOCK_DIST ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist'));

const world = buildWorld(SCENARIO);
scaleWorld(world);
const state: AppState = world.state;
// MOCK_EXTRA=path: a JSON of more sessions, ledger items, machines, live views and machine
// stats, added to the scenario (w1430's sidebar stills used one).
if (process.env.MOCK_EXTRA) {
  const x = JSON.parse(fs.readFileSync(process.env.MOCK_EXTRA, 'utf8'));
  state.sessions.push(...(x.sessions ?? []));
  if (x.work) state.work = [...(state.work ?? []), ...x.work];
  if (x.room) state.room = x.room;
  state.machines.push(...(x.machines ?? []));
  if (x.live) state.live = [...(state.live ?? []), ...x.live];
  if (x.machineStats) state.machineStats = { ...state.machineStats, ...x.machineStats };
}
const transcripts = world.transcripts;
const seqs: Record<string, number> = {};
for (const [id, evs] of Object.entries(transcripts)) seqs[id] = evs.at(-1)?.seq ?? 0;
const uploadImages = new Map<string, Buffer>(); // `${sessionId}/${id}` → png, for images sent from the page

// ---------------------------------------------------------------- images

const pictures = new Map<ImageKey, Buffer>();
function picture(key: ImageKey): Buffer {
  let png = pictures.get(key);
  if (!png) {
    const base = { width: 1280, height: 720 };
    png =
      key === 'phone'
        ? phoneShot(7)
        : key === 'before'
          ? spaceScene({ ...base, seed: 3, bloom: 0.1, beltGlow: 0.15 })
          : key === 'after-bloom'
            ? spaceScene({ ...base, seed: 3, bloom: 1, beltGlow: 1 })
            : key === 'after-belts'
              ? spaceScene({ ...base, seed: 3, bloom: 1, beltGlow: 0.25 })
              : key === 'bh-v1'
                ? spaceScene({ ...base, seed: 11, bloom: 0.5, hole: { x: 0.5, y: 0.42, r: 0.16 }, beltGlow: 0.2 })
                : key === 'bh-v2'
                  ? spaceScene({ ...base, seed: 11, bloom: 0.9, hole: { x: 0.5, y: 0.42, r: 0.16 }, beltGlow: 0.2, tint: [0.2, 0.25, 0.7] })
                  : spaceScene({ ...base, seed: key.length * 17, bloom: 0.6 });
    pictures.set(key, png);
  }
  return png;
}

// ---------------------------------------------------------------- live view (w1398, docs/live-view.md)

// The comet catch session's materials and their knobs, as the game's look.material.list reports them; values live here.
const liveMaterials: Record<string, { shader: string; knobs: (LiveKnob & { original: number | number[] })[] }> = {};
function addMaterial(material: string, shader: string, knobs: Omit<LiveKnob, 'moved'>[]) {
  liveMaterials[material] = { shader, knobs: knobs.map((k) => ({ ...k, value: Array.isArray(k.value) ? [...k.value] : k.value, original: Array.isArray(k.value) ? [...k.value] : k.value })) };
}
addMaterial('VfxComet', 'FinalFactory/VfxComet', [
  { name: '_Intensity', label: 'Overall Intensity', type: 'range', value: 1, min: 0, max: 4 },
  { name: '_ComaColor', label: 'Coma Color', type: 'color', value: [0.4, 0.9, 2.4, 1], hdr: true },
  { name: '_ComaCore', label: 'Coma Core', type: 'color', value: [2.4, 2.2, 1.8, 1], hdr: true },
  { name: '_ComaRadius', label: 'Coma Radius', type: 'range', value: 2.5, min: 0.5, max: 8 },
  { name: '_IonSpeed', label: 'Ion Speed', type: 'float', value: 1.2 },
  { name: '_Rings', label: 'Ring Count', type: 'int', value: 3 },
  { name: '_Flow', label: 'Flow Direction', type: 'vector', value: [0.2, -0.4, 0, 0] },
]);
addMaterial('CometCatcherMaterial', 'FinalFactory/CometCatcher', [{ name: '_EmissionAG', label: 'Emission AG', type: 'color', value: [64, 0, 33.6, 1], hdr: true }]);
const liveKnobsOf = () => Object.entries(liveMaterials).map(([material, m]) => ({ material, shader: m.shader, knobs: m.knobs.map(({ original, ...k }) => ({ ...k, moved: JSON.stringify(k.value) !== JSON.stringify(original) || undefined })) }));
const liveKnob = (material: string, name: string) => liveMaterials[material]?.knobs.find((k) => k.name === name);

/** The picture the knobs describe: bloom from the intensity, the nebula's tint from the coma colour, the glowing body from the radius. */
function liveParams() {
  const v = liveMaterials.VfxComet.knobs;
  const get = (n: string) => v.find((k) => k.name === n)!.value;
  const color = get('_ComaColor') as number[];
  const k = Math.max(color[0], color[1], color[2], 1e-6);
  const q = (x: number, step: number) => Math.round(x / step) * step;
  const ems = liveMaterials.CometCatcherMaterial.knobs[0].value as number[];
  return {
    bloom: q((get('_Intensity') as number) * 0.55, 0.05),
    tint: [q(color[0] / k, 0.1), q(color[1] / k, 0.1), q(color[2] / k, 0.1)] as [number, number, number],
    r: q(0.05 + ((get('_ComaRadius') as number) / 8) * 0.17, 0.005),
    belts: q(Math.min(1.5, Math.max(...ems.slice(0, 3)) / 64), 0.1),
  };
}
const liveFrames = new Map<string, Buffer>();
function liveFrame(): Buffer {
  const p = liveParams();
  const key = JSON.stringify(p);
  let png = liveFrames.get(key);
  if (!png) {
    png = spaceScene({ width: 640, height: 360, seed: 29, bloom: p.bloom, beltGlow: p.belts, hole: { x: 0.5, y: 0.4, r: p.r }, tint: p.tint });
    if (liveFrames.size > 200) liveFrames.clear();
    liveFrames.set(key, png);
  }
  return png;
}
const liveViewers = new Set<{ ws: WebSocket; sessionId: string }>();
const liveSend = (frame: Buffer) => {
  for (const v of liveViewers) if (v.ws.readyState === 1 && v.ws.bufferedAmount < 1_000_000) v.ws.send(frame, { binary: true });
};
function liveSetState(next: LiveViewInfo['state'], detail = '') {
  const view = state.live?.[0];
  if (!view) return;
  Object.assign(view, { state: next, detail, updatedAt: new Date().toISOString() });
  broadcast({ type: 'live', views: state.live! });
}

// ---------------------------------------------------------------- transcripts & broadcast

const wss = new WebSocketServer({ noServer: true });
const liveWss = new WebSocketServer({ noServer: true });
const now = () => new Date().toISOString();
const find = (id: string) => state.sessions.find((s) => s.id === id);

// Every sandbox is a machine's (w510); BEAST's are on its own daemon, the machine with `local`.
const machineById = (id: string | undefined) => state.machines.find((x) => x.id === id);
const sandboxOn = (machineId: string | undefined, id: string | undefined) => machineById(machineId)?.sandboxes?.find((x) => x.id === id);
const allSandboxes = () => state.machines.flatMap((m) => (m.sandboxes ?? []).map((sb) => ({ machine: m, sb })));
const sendMachine = (machine: Machine) => broadcast({ type: 'machine', machine });
/** The local machine; a world without one (the fresh scenario) gets it when the first sandbox is created. */
function localOrNew(): Machine {
  let m = state.machines.find((x) => x.local);
  if (!m) {
    m = localMachine(Date.now());
    state.machines.unshift(m);
    sendMachine(m);
  }
  return m;
}

function broadcast(ev: ServerEvent) {
  const s = JSON.stringify(ev);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}

type NewEvent = TranscriptEvent extends infer E ? (E extends { seq: number; t: string } ? Omit<E, 'seq' | 't'> : never) : never;

function append(sessionId: string, e: NewEvent): TranscriptEvent {
  seqs[sessionId] = (seqs[sessionId] ?? 0) + 1;
  const ev = { ...(e as object), seq: seqs[sessionId], t: now() } as TranscriptEvent;
  (transcripts[sessionId] ??= []).push(ev);
  broadcast({ type: 'transcript', sessionId, event: ev });
  return ev;
}

function update(s: SessionInfo, patch: Partial<SessionInfo> = {}) {
  Object.assign(s, patch, { lastActivityAt: now() });
  broadcast({ type: 'session', session: s });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- simulated turns

const turns = new Map<string, { interrupted: boolean; resume?: (allow: boolean) => void }>();

async function simulateTurn(sessionId: string, text: string, from: 'human' | 'orchestrator' = 'human', images?: { mediaType: string; data: string }[]) {
  const s = find(sessionId);
  if (!s) return;
  const refs = (images ?? []).map((img, i) => {
    const id = `up-${Date.now().toString(36)}-${i}`;
    uploadImages.set(`${sessionId}/${id}`, Buffer.from(img.data, 'base64'));
    return { id, mediaType: img.mediaType };
  });
  append(sessionId, { kind: 'user', text, from, ...(refs.length ? { images: refs } : {}) });
  const turn = { interrupted: false } as { interrupted: boolean; resume?: (allow: boolean) => void };
  turns.set(sessionId, turn);
  update(s, { status: 'running', statusDetail: undefined });
  const slow = /slow/i.test(text);
  const t0 = Date.now();
  await sleep(700);
  if (turn.interrupted) return;
  append(sessionId, { kind: 'thinking', text: 'Check which sandboxes and agents this is about before answering; nothing here needs a new sandbox.' });
  const tid = 'm' + Math.random().toString(36).slice(2, 8);
  append(sessionId, { kind: 'tool_use', toolUseId: tid, name: s.kind === 'orchestrator' ? 'mcp__sandboxes__list_sandboxes' : 'Bash', input: s.kind === 'orchestrator' ? {} : { command: 'git status --short', description: 'Changed files' } });
  await sleep(slow ? 2500 : 900);
  if (turn.interrupted) return;
  append(sessionId, { kind: 'tool_result', toolUseId: tid, isError: false, text: s.kind === 'orchestrator' ? JSON.stringify(allSandboxes().map(({ sb }) => ({ id: sb.id, label: sb.purpose }))) : ' M Assets/Settings/URP/PostProcess_Space.asset' });
  if (/perm/i.test(text)) {
    const requestId = 'p' + Math.random().toString(36).slice(2, 8);
    const input = { command: 'rm -rf Library/ScriptAssemblies', description: 'Clear stale assemblies' };
    update(s, { status: 'waiting_permission', pendingPermissions: [...s.pendingPermissions, { requestId, toolName: 'Bash', input, reason: 'Deletes files', createdAt: now() }] });
    append(sessionId, { kind: 'permission', requestId, toolName: 'Bash', input });
    const allowed = await new Promise<boolean>((r) => (turn.resume = r));
    if (turn.interrupted) return;
    append(sessionId, { kind: 'tool_use', toolUseId: tid + 'b', name: 'Bash', input });
    append(sessionId, { kind: 'tool_result', toolUseId: tid + 'b', isError: !allowed, text: allowed ? '' : 'Denied by the user in the sandbox UI.' });
  }
  if (/fail/i.test(text)) {
    append(sessionId, { kind: 'error', text: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' });
    update(s, { status: 'error', statusDetail: 'API Error: 529 overloaded' });
    turns.delete(sessionId);
    return;
  }
  const names = allSandboxes().filter(({ sb }) => sb.status === 'ready').map(({ sb }) => `**${sb.purpose === 'unused' ? `${sb.id} (free)` : sb.purpose}**`);
  const reply =
    s.kind === 'orchestrator'
      ? `On it. Here is where things stand for "${text.slice(0, 60)}":\n\n- ${names.slice(0, 3).join('\n- ')}\n\nThe lighting pass is still working on the belt materials; I will report back when it has screenshots. Anything else?`
      : `Done: \`PostProcess_Space.asset\` is the only change. Bloom threshold 1.4, intensity 0.5.\n\n\`\`\`yaml\nthreshold: {m_OverrideState: 1, m_Value: 1.4}\nintensity: {m_OverrideState: 1, m_Value: 0.5}\n\`\`\``;
  for (const piece of reply.match(/[\s\S]{1,5}/g) ?? []) {
    if (turn.interrupted) return;
    broadcast({ type: 'delta', sessionId, text: piece });
    await sleep(slow ? 120 : 30);
  }
  if (turn.interrupted) return;
  append(sessionId, { kind: 'assistant', text: reply });
  append(sessionId, { kind: 'result', ok: true, text: reply, costUsd: 0.07, turns: 2, durationMs: Date.now() - t0 });
  update(s, { status: 'idle', turns: s.turns + 1, costUsd: s.costUsd + 0.07, lastResult: reply.slice(0, 300) });
  turns.delete(sessionId);
}

async function interrupt(sessionId: string) {
  const s = find(sessionId);
  const turn = turns.get(sessionId);
  if (!s || !turn) return;
  turn.interrupted = true;
  turn.resume?.(false);
  turns.delete(sessionId);
  append(sessionId, { kind: 'system', text: 'Interrupted.' });
  update(s, { status: 'idle', pendingPermissions: [] });
}

// ---------------------------------------------------------------- search

function search(q: string): { hits: SearchHit[]; scanned: number; ms: number } {
  const t0 = Date.now();
  const words = [...q.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] ?? m[2]).toLowerCase());
  const hits: SearchHit[] = [];
  for (const [sessionId, evs] of Object.entries(transcripts)) {
    const s = find(sessionId);
    for (const e of evs) {
      const text = 'text' in e ? e.text : e.kind === 'tool_use' ? `${e.name} ${JSON.stringify(e.input)}` : '';
      const low = text.toLowerCase();
      if (!words.length || !words.every((w) => low.includes(w))) continue;
      const at = Math.max(0, low.indexOf(words[0]) - 60);
      hits.push({
        sessionId,
        seq: e.seq,
        t: e.t,
        kind: e.kind,
        snippet: (at ? '…' : '') + text.slice(at, at + 220).replace(/\s+/g, ' ') + (text.length > at + 220 ? '…' : ''),
        title: s?.kind === 'orchestrator' ? 'Orchestrator' : (s?.title ?? sessionId),
        sessionKind: s?.kind,
        sandboxId: s?.sandboxId,
        machineId: s?.machineId,
        machineSandbox: s?.machineSandbox,
        standingId: s?.standingId,
      });
    }
  }
  hits.sort((a, b) => b.t.localeCompare(a.t));
  return { hits: hits.slice(0, 100), scanned: Object.keys(transcripts).length, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- http

const authed = new Set<string>();
const isAuthed = (cookie: string | undefined) => NOAUTH || authed.has(/ffsb=([^;]+)/.exec(cookie ?? '')?.[1] ?? '');

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

function serveStatic(pathname: string, res: http.ServerResponse) {
  let f = path.join(DIST, decodeURIComponent(pathname));
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  if (!fs.existsSync(f)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('web/dist is missing: run `npm --prefix web run build`, or use Vite (`npm --prefix web run dev`).');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const json = (code: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const png = (buf: Buffer | undefined) => {
    if (!buf) return json(404, { error: 'no such image' });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
    res.end(buf);
  };
  if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);

  let raw = '';
  for await (const c of req) raw += c;
  let data: Record<string, any> = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    return json(400, { error: 'bad JSON' });
  }

  if (url.pathname === '/api/login') {
    if (data.password === 'mock') {
      const t = Math.random().toString(36).slice(2);
      authed.add(t);
      return json(200, { username: data.username || 'ben' }, { 'Set-Cookie': `ffsb=${t}; Path=/; HttpOnly; SameSite=Strict` });
    }
    await sleep(400);
    return json(401, { error: 'Wrong username or password' });
  }
  if (!isAuthed(req.headers.cookie)) return json(401, { error: 'unauthorized' });

  const m = (re: RegExp) => re.exec(url.pathname);
  let r: RegExpExecArray | null;
  const method = req.method ?? 'GET';

  if (url.pathname === '/api/logout') return json(200, {});
  if (url.pathname === '/api/state') return json(200, state);

  if ((r = m(/^\/api\/sessions\/([^/]+)\/events$/))) {
    const all = transcripts[r[1]] ?? [];
    const from = url.searchParams.get('from');
    if (from) return json(200, all.filter((e) => e.seq >= Number(from)));
    return json(200, all.slice(-Number(url.searchParams.get('limit') ?? 500)));
  }
  if ((r = m(/^\/api\/sessions\/([^/]+)\/message$/))) {
    const s = find(r[1]);
    if (!s) return json(404, { error: `no session "${r[1]}"` });
    if (s.status === 'running' && s.kind !== 'standing') {
      // Queued behind the turn in flight, as the real server does.
      append(s.id, { kind: 'user', text: data.text, from: 'human' });
      return json(200, {});
    }
    void simulateTurn(s.id, data.text ?? '', 'human', data.images);
    return json(200, s.kind === 'standing' ? { note: 'Started a run.' } : {});
  }
  if ((r = m(/^\/api\/sessions\/([^/]+)\/interrupt$/))) {
    await interrupt(r[1]);
    return json(200, {});
  }
  if ((r = m(/^\/api\/sessions\/([^/]+)\/permission$/))) {
    const s = find(r[1]);
    if (!s) return json(404, { error: 'no such session' });
    s.pendingPermissions = s.pendingPermissions.filter((x) => x.requestId !== data.requestId);
    const ev = (transcripts[s.id] ?? []).find((e) => e.kind === 'permission' && e.requestId === data.requestId);
    if (ev && ev.kind === 'permission') {
      ev.decision = data.allow ? 'allow' : 'deny';
      broadcast({ type: 'transcript', sessionId: s.id, event: ev });
    }
    const turn = turns.get(s.id);
    update(s, { status: s.pendingPermissions.length ? 'waiting_permission' : turn ? 'running' : 'idle' });
    turn?.resume?.(!!data.allow);
    return json(200, {});
  }
  if ((r = m(/^\/api\/sessions\/([^/]+)\/mode$/))) {
    const s = find(r[1]);
    if (s) update(s, { permissionMode: data.mode });
    return json(200, {});
  }
  if ((r = m(/^\/api\/sessions\/([^/]+)\/title$/))) {
    const s = find(r[1]);
    if (s) update(s, { title: String(data.title).trim() });
    return json(200, { title: s?.title });
  }
  if (url.pathname === '/api/sessions' && method === 'POST') {
    const id = 'w' + Math.random().toString(36).slice(2, 7);
    // The page names the place as machineId (+ machineSandbox), or as a sandboxId: "<machine>/<id>", or a bare id on the local machine.
    const [viaMachine, viaSandbox] = String(data.sandboxId ?? '').includes('/') ? String(data.sandboxId).split('/') : [undefined, data.sandboxId as string | undefined];
    const machineId: string | undefined = data.machineId ?? viaMachine ?? (viaSandbox ? state.machines.find((x) => x.local)?.id : undefined);
    const machineSandbox: string | undefined = data.machineSandbox ?? viaSandbox;
    const s: SessionInfo = {
      id,
      kind: 'worker',
      machineId,
      machineSandbox,
      title: data.title || String(data.prompt).replace(/\s+/g, ' ').slice(0, 60),
      status: 'starting',
      model: data.model,
      effort: data.effort,
      permissionMode: data.permissionMode ?? 'bypassPermissions',
      createdAt: now(),
      lastActivityAt: now(),
      turns: 0,
      costUsd: 0,
      pendingPermissions: [],
    };
    state.sessions.push(s);
    const owner = machineById(machineId);
    if (owner) {
      owner.sessionIds.push(id);
      sandboxOn(machineId, machineSandbox)?.sessionIds.push(id);
      sendMachine(owner);
    }
    update(s);
    void simulateTurn(id, data.prompt, 'human');
    return json(200, s);
  }
  if ((r = m(/^\/api\/sessions\/([^/]+)$/)) && method === 'DELETE') {
    const id = r[1];
    state.sessions = state.sessions.filter((x) => x.id !== id);
    for (const machine of state.machines) {
      const places = [machine, ...(machine.sandboxes ?? [])];
      if (!places.some((x) => x.sessionIds.includes(id))) continue;
      for (const x of places) x.sessionIds = x.sessionIds.filter((v) => v !== id);
      sendMachine(machine);
    }
    broadcast({ type: 'session_removed', id });
    return json(200, {});
  }
  if ((r = m(/^\/api\/uploads\/([^/]+)\/([^/]+)$/))) {
    const key = `${decodeURIComponent(r[1])}/${decodeURIComponent(r[2])}`;
    const pic = world.uploads[key];
    return png(pic ? picture(pic) : uploadImages.get(key));
  }
  if (url.pathname === '/api/image') {
    const p = (url.searchParams.get('path') ?? '').replace(/\\/g, '/').toLowerCase();
    const pic = world.files[p];
    return png(pic ? picture(pic) : undefined);
  }
  if (url.pathname === '/api/screenshots') {
    // A machine's gallery covers its sandboxes' folders too; a sandbox is "<machine>/<id>" or the bare id.
    const machine = url.searchParams.get('machine');
    const ids = machine ? [machine, ...(machineById(machine)?.sandboxes ?? []).map((x) => x.id)] : [(url.searchParams.get('sandbox') ?? '').split('/').pop()!];
    const list = Object.keys(world.files)
      .filter((p) => ids.some((id) => p.includes(`/${id.toLowerCase()}/`)))
      .map((p, i) => ({ path: p.replace(/\//g, '\\'), size: 1_200_000 + i * 91_000, mtime: new Date(Date.now() - (i + 1) * 17 * 60_000).toISOString() }));
    return json(200, list);
  }
  if (url.pathname === '/api/orchestrator/reset') {
    const id = data.which === 'dispatcher' ? (state.dispatcherId ?? state.orchestratorId) : state.orchestratorId;
    transcripts[id] = [];
    seqs[id] = 0;
    return json(200, { id });
  }
  // Creating a sandbox: on the local machine (BEAST's own daemon), as the portal's route does.
  if (url.pathname === '/api/sandboxes' && method === 'POST') {
    const id = String(data.name);
    const host = localOrNew();
    if (host.sandboxes?.some((x) => x.id === id)) return json(409, { error: `sandbox "${id}" already exists on ${host.id}` });
    const root = host.sandboxRoot ?? 'F:/ffsb';
    const sbx: MachineSandbox = {
      id,
      branch: data.branch ?? `sandbox/${id}`,
      base: data.base ?? 'origin/master',
      path: `${root}/${id}`,
      purpose: data.purpose ?? 'unused',
      status: 'creating',
      statusDetail: 'git worktree add…',
      createdAt: now(),
      sessionIds: [],
      unity: { state: 'stopped' },
    };
    (host.sandboxes ??= []).push(sbx);
    sendMachine(host);
    setTimeout(() => (Object.assign(sbx, { statusDetail: 'Copying Library seed (12 / 64 GB)' }), sendMachine(host)), 1500);
    setTimeout(() => (Object.assign(sbx, { status: 'ready', statusDetail: undefined }), sendMachine(host)), 5000);
    return json(200, { machine: host.id, id, note: `Creating sandbox ${id} on ${host.id}.` });
  }
  if ((r = m(/^\/api\/machines\/([^/]+)\/sandboxes\/([^/]+)\/unity$/))) {
    const host = machineById(r[1]);
    const sbx = sandboxOn(r[1], r[2]);
    if (!host || !sbx) return json(404, { error: 'no such sandbox' });
    // A machine sandbox's editor has no "stopping" state: a stop shows as running with a detail until it is down.
    const start = data.action === 'start';
    sbx.unity = start ? { state: 'starting' } : { ...sbx.unity, detail: 'Stopping…' };
    sendMachine(host);
    setTimeout(() => {
      sbx.unity = start ? { state: 'running', pid: 4242, logPath: `${sbx.path}/Logs/sandbox-editor.log` } : { state: 'stopped' };
      sendMachine(host);
    }, 2500);
    return json(200, { note: start ? 'Starting Unity.' : 'Stopping Unity.' });
  }
  if ((r = m(/^\/api\/machines\/([^/]+)\/sandboxes\/([^/]+)\/unity-log$/))) {
    if (!sandboxOn(r[1], r[2])) return json(404, { error: 'no such sandbox' });
    return json(200, {
      lines: Array.from({ length: 120 }, (_, i) =>
        i % 29 === 0
          ? "Assets/Scripts/FFSystems/Logistics/BeltSplitterSystem.cs(88,17): error CS0103: The name 'splitIndex' does not exist in the current context"
          : i % 11 === 0
            ? `Warning: Shader variant stripped: BlackHole (pass ${i})`
            : `[${String(i).padStart(3, '0')}] Refreshing native plugins compatible for Editor in ${(i * 0.37).toFixed(2)} ms. Found 12 plugins.`,
      ),
    });
  }
  if ((r = m(/^\/api\/machines\/([^/]+)(?:\/sandboxes\/([^/]+))?\/switch-branch$/))) return json(200, { note: `Switched to ${data.branch}.` });
  if ((r = m(/^\/api\/machines\/([^/]+)\/label$/))) {
    const mc = state.machines.find((x) => x.id === r![1]);
    if (mc) {
      mc.purpose = data.purpose;
      broadcast({ type: 'machine', machine: mc });
    }
    return json(200, mc);
  }
  if ((r = m(/^\/api\/machines\/([^/]+)\/redeploy$/))) return json(200, state.machines.find((x) => x.id === r![1]));
  if ((r = m(/^\/api\/delegations\/([^/]+)\/(approve|reject|bump)$/))) {
    const d = state.delegations.find((x) => x.id === r![1]);
    if (!d) return json(404, { error: 'no such request' });
    // w527: approving (or Start now) files it in the ledger; the mock only records the request id.
    Object.assign(d, { status: r[2] === 'reject' ? 'rejected' : 'approved', decidedAt: now(), ...(r[2] !== 'reject' ? { workId: d.workId ?? 'w-mock' } : {}) });
    broadcast({ type: 'delegation', request: d });
    return json(200, d);
  }
  if ((r = m(/^\/api\/standing\/([^/]+)\/(run|stop|pause|resume)$/))) {
    const a = state.standingAgents.find((x) => x.id === r![1]);
    if (!a) return json(404, { error: 'no such agent' });
    if (r[2] === 'pause' || r[2] === 'resume') {
      Object.assign(a, { enabled: r[2] === 'resume', state: r[2] === 'resume' ? 'asleep' : 'paused' });
      broadcast({ type: 'standing', agent: a });
      return json(200, a);
    }
    Object.assign(a, { state: r[2] === 'run' ? 'running' : 'asleep' });
    broadcast({ type: 'standing', agent: a });
    return json(200, { note: r[2] === 'run' ? `Started a run of ${a.name}.` : `Stopped ${a.name}'s run.` });
  }
  if (url.pathname === '/api/settings' && method === 'POST') {
    // heartbeatMinutes is the signed-in person's own heartbeat (docs/orchestrators.md).
    const me = state.me?.userId ?? 'ben';
    const heartbeat = { ...state.settings.heartbeat };
    if (data.heartbeatMinutes) heartbeat[me] = Number(data.heartbeatMinutes);
    else delete heartbeat[me];
    state.settings = { ...state.settings, heartbeat };
    broadcast({ type: 'settings', settings: state.settings });
    return json(200, state.settings);
  }
  // The live view (docs/live-view.md): knobs of the session's materials, kept in memory.
  if ((r = m(/^\/api\/live\/([^/]+)\/(knobs|knob|reset)$/))) {
    const view = state.live?.find((v) => v.sessionId === decodeURIComponent(r![1]));
    if (!view) return json(404, { error: 'no live view for this session: its agent starts one with live_view' });
    if (r[2] === 'knobs') return json(200, liveKnobsOf());
    if (r[2] === 'reset') {
      for (const [name, mat] of Object.entries(liveMaterials)) {
        if (data.material !== undefined && data.material !== name) continue;
        for (const k of mat.knobs) k.value = Array.isArray(k.original) ? [...k.original] : k.original;
      }
      if (FROZEN) liveSend(liveFrame());
      return json(200, { ok: true });
    }
    const knob = liveKnob(String(data.material), String(data.name));
    if (!knob) return json(400, { error: `"${data.material}.${data.name}" is not a knob of this view's materials` });
    const value = data.value;
    const numbers = Array.isArray(value) ? value : [value];
    if (!numbers.length || numbers.some((x: unknown) => typeof x !== 'number' || !isFinite(x))) return json(400, { error: 'a knob value is a number, or 3 or 4 numbers (a colour or a vector)' });
    // One refusal to see: the game rejects an ion speed that would tear the trail.
    if (knob.name === '_IonSpeed' && (value as number) > 6) return json(400, { error: '_IonSpeed above 6 tears the ion trail: the game kept 1.2' });
    knob.value = Array.isArray(value) ? [...value] : (knob.type === 'int' ? Math.round(value) : value);
    await sleep(25);
    if (FROZEN) liveSend(liveFrame());
    const { original, ...answer } = knob;
    return json(200, { ok: true, knob: { ...answer, moved: JSON.stringify(knob.value) !== JSON.stringify(original) || undefined } });
  }
  // Mock only: put the live view in a state, to see how the page shows it. {"state":"holding","detail":"Reloading scripts…"}
  if (url.pathname === '/api/mock/live' && state.live?.length) {
    liveSetState(data.state ?? 'live', data.detail ?? '');
    return json(200, state.live[0]);
  }
  if (url.pathname === '/api/search') return json(200, search(url.searchParams.get('q') ?? ''));
  if (url.pathname === '/api/push') return json(200, { publicKey: 'BNmockmockmockmockmockmockmockmockmockmockmockmockmockmockmockmockmockmockmock', subscriptions: [] });
  if (url.pathname.startsWith('/api/push/')) return json(200, { prefs: data.prefs ?? {}, delivered: 0 });
  if (url.pathname === '/api/voice' || url.pathname === '/api/voice/warm' || url.pathname === '/api/voice/install') {
    return json(200, { state: 'idle', model: 'large-v3-turbo', tts: { state: 'idle', voice: 'af_heart' } });
  }
  if (url.pathname === '/api/voice/transcribe') return json(200, { text: "how's the lighting pass doing", model: 'large-v3-turbo', device: 'cuda', audioSeconds: 2.1, seconds: 0.2, totalSeconds: 0.3 });
  json(404, { error: `mock: no route for ${method} ${url.pathname}` });
});

server.on('upgrade', (req, sock, head) => {
  if (!isAuthed(req.headers.cookie)) {
    sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    sock.destroy();
    return;
  }
  // /live/<sessionId>: binary JPEG frames in the real portal; the mock sends PNGs of a space scene that follows the knobs.
  const liveSession = /^\/live\/([^/?]+)/.exec(new URL(req.url ?? '/', 'http://x').pathname)?.[1];
  if (liveSession) {
    liveWss.handleUpgrade(req, sock, head, (ws: WebSocket) => {
      const id = decodeURIComponent(liveSession);
      if (!state.live?.some((v) => v.sessionId === id)) return ws.close(1008, 'no live view for this session');
      const viewer = { ws, sessionId: id };
      liveViewers.add(viewer);
      ws.on('close', () => liveViewers.delete(viewer));
      ws.send(liveFrame(), { binary: true });
    });
    return;
  }
  wss.handleUpgrade(req, sock, head, (ws: WebSocket) => ws.send(JSON.stringify({ type: 'state', state } satisfies ServerEvent)));
});

if (!FROZEN) {
  setInterval(() => {
    const sys = state.system!;
    sys.loadPct = Math.max(3, Math.min(99, sys.loadPct + (Math.random() - 0.5) * 8));
    sys.gpu!.utilPct = Math.max(0, Math.min(100, sys.gpu!.utilPct + (Math.random() - 0.5) * 10));
    broadcast({ type: 'system', system: sys });
  }, 3000);
}

// About 10 frames a second to whoever watches; MOCK_FROZEN sends the same bytes until a knob moves (stable screenshots).
setInterval(() => {
  if (!liveViewers.size || state.live?.[0]?.state !== 'live') return;
  liveSend(liveFrame());
}, 100);
if (process.env.MOCK_LIVE_STATE && state.live?.length) liveSetState(process.env.MOCK_LIVE_STATE as LiveViewInfo['state'], process.env.MOCK_LIVE_DETAIL ?? 'Reloading scripts: a script change (CometVfxPresentationSystem.cs). Back in about a minute.');

startLiveTraffic(world, broadcast, append as never);

server.listen(PORT, () => console.log(`mock FF Factory backend (${SCENARIO}) on http://localhost:${PORT}: any username, password "mock"`));
