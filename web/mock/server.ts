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
import type { AppState, SearchHit, ServerEvent, SessionInfo, TranscriptEvent } from '../../shared/types.ts';
import { buildWorld, type ImageKey, type Scenario } from './scenario.ts';
import { phoneShot, spaceScene } from './png.ts';

const PORT = Number(process.env.PORT ?? 8790);
const NOAUTH = process.env.MOCK_NOAUTH === '1';
const FROZEN = process.env.MOCK_FROZEN === '1';
const SCENARIO = (process.env.MOCK_SCENARIO ?? 'busy') as Scenario;
const DIST = path.resolve(process.env.MOCK_DIST ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist'));

const world = buildWorld(SCENARIO);
const state: AppState = world.state;
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

// ---------------------------------------------------------------- transcripts & broadcast

const wss = new WebSocketServer({ noServer: true });
const now = () => new Date().toISOString();
const find = (id: string) => state.sessions.find((s) => s.id === id);

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
  append(sessionId, { kind: 'tool_result', toolUseId: tid, isError: false, text: s.kind === 'orchestrator' ? JSON.stringify(state.sandboxes.map((x) => ({ id: x.id, label: x.purpose }))) : ' M Assets/Settings/URP/PostProcess_Space.asset' });
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
  const names = state.sandboxes.filter((x) => x.status === 'ready').map((x) => `**${x.purpose === 'unused' ? `${x.id} (free)` : x.purpose}**`);
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
    const s: SessionInfo = {
      id,
      kind: 'worker',
      sandboxId: data.sandboxId,
      machineId: data.machineId,
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
    const owner = state.sandboxes.find((x) => x.id === data.sandboxId) ?? state.machines.find((x) => x.id === data.machineId);
    if (owner) {
      owner.sessionIds.push(id);
      if ('unity' in owner) broadcast({ type: 'sandbox', sandbox: owner });
      else broadcast({ type: 'machine', machine: owner });
    }
    update(s);
    void simulateTurn(id, data.prompt, 'human');
    return json(200, s);
  }
  if ((r = m(/^\/api\/sessions\/([^/]+)$/)) && method === 'DELETE') {
    const id = r[1];
    state.sessions = state.sessions.filter((x) => x.id !== id);
    for (const owner of [...state.sandboxes, ...state.machines])
      if (owner.sessionIds.includes(id)) {
        owner.sessionIds = owner.sessionIds.filter((x) => x !== id);
        if ('unity' in owner) broadcast({ type: 'sandbox', sandbox: owner });
        else broadcast({ type: 'machine', machine: owner });
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
    const id = url.searchParams.get('sandbox') ?? url.searchParams.get('machine') ?? '';
    const list = Object.keys(world.files)
      .filter((p) => p.includes(`/${id.toLowerCase()}/`))
      .map((p, i) => ({ path: p.replace(/\//g, '\\'), size: 1_200_000 + i * 91_000, mtime: new Date(Date.now() - (i + 1) * 17 * 60_000).toISOString() }));
    return json(200, list);
  }
  if (url.pathname === '/api/orchestrator/reset') {
    transcripts[state.orchestratorId] = [];
    seqs[state.orchestratorId] = 0;
    return json(200, {});
  }
  if (url.pathname === '/api/sandboxes' && method === 'POST') {
    const id = String(data.name);
    const sbx = {
      id,
      name: id,
      branch: data.branch ?? `sandbox/${id}`,
      base: data.base ?? 'origin/develop',
      path: `F:\\ffsb\\${id}`,
      purpose: data.purpose ?? 'unused',
      status: 'creating' as const,
      statusDetail: 'git worktree add…',
      createdAt: now(),
      sessionIds: [],
      unity: { state: 'stopped' as const },
    };
    state.sandboxes.push(sbx);
    broadcast({ type: 'sandbox', sandbox: sbx });
    setTimeout(() => (Object.assign(sbx, { statusDetail: 'Copying Library seed (12 / 64 GB)' }), broadcast({ type: 'sandbox', sandbox: sbx })), 1500);
    setTimeout(() => (Object.assign(sbx, { status: 'ready', statusDetail: undefined }), broadcast({ type: 'sandbox', sandbox: sbx })), 5000);
    return json(200, sbx);
  }
  if ((r = m(/^\/api\/sandboxes\/([^/]+)$/)) && method === 'DELETE') {
    const sbx = state.sandboxes.find((x) => x.id === r![1]);
    if (!sbx) return json(404, { error: 'no such sandbox' });
    sbx.status = 'deleting';
    broadcast({ type: 'sandbox', sandbox: sbx });
    setTimeout(() => {
      state.sandboxes = state.sandboxes.filter((x) => x.id !== sbx.id);
      broadcast({ type: 'sandbox_removed', id: sbx.id });
    }, 2000);
    return json(200, {});
  }
  if ((r = m(/^\/api\/sandboxes\/([^/]+)\/unity$/))) {
    const sbx = state.sandboxes.find((x) => x.id === r![1]);
    if (!sbx) return json(404, { error: 'no such sandbox' });
    const start = data.action === 'start';
    sbx.unity = { state: start ? 'starting' : 'stopping' };
    broadcast({ type: 'sandbox', sandbox: sbx });
    setTimeout(() => {
      sbx.unity = start ? { state: 'running', pid: 4242, startedAt: now() } : { state: 'stopped' };
      broadcast({ type: 'sandbox', sandbox: sbx });
    }, 2500);
    return json(200, {});
  }
  if ((r = m(/^\/api\/sandboxes\/([^/]+)\/unity-log$/))) {
    return json(200, {
      lines: Array.from({ length: 120 }, (_, i) =>
        i % 29 === 0
          ? 'Assets/Scripts/FFSystems/Logistics/BeltSplitterSystem.cs(88,17): error CS0103: The name \'splitIndex\' does not exist in the current context'
          : i % 11 === 0
            ? `Warning: Shader variant stripped: BlackHole (pass ${i})`
            : `[${String(i).padStart(3, '0')}] Refreshing native plugins compatible for Editor in ${(i * 0.37).toFixed(2)} ms. Found 12 plugins.`,
      ),
    });
  }
  if ((r = m(/^\/api\/(sandboxes|machines)\/([^/]+)\/switch-branch$/))) return json(200, { note: `Switched to ${data.branch}.` });
  if ((r = m(/^\/api\/machines\/([^/]+)\/label$/))) {
    const mc = state.machines.find((x) => x.id === r![1]);
    if (mc) {
      mc.purpose = data.purpose;
      broadcast({ type: 'machine', machine: mc });
    }
    return json(200, mc);
  }
  if ((r = m(/^\/api\/machines\/([^/]+)\/redeploy$/))) return json(200, state.machines.find((x) => x.id === r![1]));
  if ((r = m(/^\/api\/delegations\/([^/]+)\/(approve|reject)$/))) {
    const d = state.delegations.find((x) => x.id === r![1]);
    if (!d) return json(404, { error: 'no such request' });
    Object.assign(d, { status: r[2] === 'approve' ? 'approved' : 'rejected', decidedAt: now(), ...(r[2] === 'approve' ? { sandboxId: 'sb-5' } : {}) });
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
    state.settings = { ...state.settings, ...data };
    broadcast({ type: 'settings', settings: state.settings });
    return json(200, state.settings);
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

server.listen(PORT, () => console.log(`mock FF Factory backend (${SCENARIO}) on http://localhost:${PORT}: any username, password "mock"`));
