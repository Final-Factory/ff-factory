// Throwaway mock of the FF Sandboxes backend, for eyeballing the UI. Not shipped.
// Run: npm run mock   (listens on :8790, same as the real server; then `npm run dev`).
// Token: "mock". Say "perm" in a message to trigger a permission request.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8790);
const now = () => new Date().toISOString();
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
const NOAUTH = process.env.MOCK_NOAUTH === '1';
let authed = new Set();
const isAuthed = (t) => NOAUTH || authed.has(t);
const wss = new WebSocketServer({ noServer: true });
let seqs = {};
const transcripts = {};

function push(sid, ev) {
  seqs[sid] = (seqs[sid] ?? 0) + 1;
  const e = { seq: seqs[sid], t: now(), ...ev };
  (transcripts[sid] ??= []).push(e);
  broadcast({ type: 'transcript', sessionId: sid, event: e });
  return e;
}

const session = (id, kind, title, extra = {}) => ({
  id, kind, title, status: 'idle', permissionMode: 'default', model: 'claude-opus-5-5',
  createdAt: ago(3600), lastActivityAt: ago(120), turns: 0, costUsd: 0, pendingPermissions: [], ...extra,
});

const state = {
  orchestratorId: 'orch',
  config: { defaultModel: 'claude-opus-5-5', models: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5'], defaultBase: 'origin/develop' },
  system: {
    hostname: 'DEVBOX', platform: 'win32', cpuModel: 'Intel Core i9-13900K', cpuCount: 32, loadPct: 23,
    memTotalBytes: 64 * 2 ** 30, memFreeBytes: 31 * 2 ** 30, diskTotalBytes: 2 * 2 ** 40, diskFreeBytes: 0.8 * 2 ** 40,
    gpu: { name: 'RTX 4080', memTotalMiB: 16376, memUsedMiB: 6120, utilPct: 18 }, limits: { maxUnity: 4, maxSessions: 8 },
  },
  sandboxes: [
    {
      id: 'sb1', name: 'shader-work', branch: 'sandbox/shader-work', base: 'origin/develop',
      path: 'D:\\ff-sandboxes\\shader-work', purpose: 'Heat shimmer + overheating shader pass for the atomic printer',
      status: 'ready', createdAt: ago(7200), sessionIds: ['w1', 'w2'],
      unity: { state: 'running', pid: 18244, startedAt: ago(5400), logPath: 'D:\\ff-sandboxes\\shader-work\\Logs\\Editor.log' },
    },
    {
      id: 'sb2', name: 'spec-098', branch: 'feature/098-belt-splitters', base: 'origin/develop',
      path: 'D:\\ff-sandboxes\\spec-098', purpose: 'spec 098', status: 'creating', statusDetail: 'Copying Library seed (4.1 / 11.2 GB)',
      createdAt: ago(60), sessionIds: [], unity: { state: 'stopped' },
    },
  ],
  sessions: [
    session('orch', 'orchestrator', 'Orchestrator'),
    session('w1', 'worker', 'Heat shimmer shader', { sandboxId: 'sb1', status: 'running', turns: 14, costUsd: 1.82, permissionMode: 'acceptEdits' }),
    session('w2', 'worker', 'Review VFX graph', { sandboxId: 'sb1', status: 'stopped', turns: 3, costUsd: 0.22 }),
  ],
};

// Seed transcripts.
push('w1', { kind: 'user', from: 'orchestrator', text: 'Build a heat shimmer effect for Overheating.mat. Keep it under 0.3ms on the RTX 4080.' });
push('w1', { kind: 'thinking', text: 'I should look at the existing material and the shader graph it uses before changing anything.' });
push('w1', { kind: 'tool_use', toolUseId: 't1', name: 'Read', input: { file_path: 'D:\\ff-sandboxes\\shader-work\\Assets\\Art\\Content\\Effects\\HeatEffect\\Overheating.mat' } });
push('w1', { kind: 'tool_result', toolUseId: 't1', isError: false, text: '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!21 &2100000\nMaterial:\n  m_Name: Overheating\n' + 'x'.repeat(2400) });
push('w1', { kind: 'tool_use', toolUseId: 't2', name: 'Bash', input: { command: 'git log --oneline -5 -- Assets/Art/Content/Effects', description: 'Recent effect commits' } });
push('w1', { kind: 'tool_result', toolUseId: 't2', isError: true, text: "fatal: not a git repository (or any of the parent directories): .git" });
push('w1', { kind: 'tool_use', toolUseId: 't3', name: 'mcp__sandboxes__unity_status', input: { sandbox: 'shader-work', verbose: true } });
push('w1', { kind: 'tool_result', toolUseId: 't3', isError: false, text: '{"state":"running","compiling":false}' });
push('w1', { kind: 'assistant', text: "The material uses **HeatDistortion.shadergraph**. Plan:\n\n1. Add a scrolling noise normal\n2. Sample `_CameraOpaqueTexture` with the offset\n3. Fade by `_Heat`\n\n| Pass | Cost |\n|---|---|\n| Noise | 0.04ms |\n| Grab | 0.11ms |" });
push('w1', { kind: 'result', ok: true, text: 'done', costUsd: 0.41, turns: 6, durationMs: 83000 });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const cookie = req.headers.cookie ?? '';
  const tok = /ffsb=([^;]+)/.exec(cookie)?.[1];
  const json = (code, body, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  let body = '';
  for await (const c of req) body += c;
  const data = body ? JSON.parse(body) : {};

  if (url.pathname === '/api/login') {
    if (data.token === 'mock') {
      const t = Math.random().toString(36).slice(2);
      authed.add(t);
      return json(200, { ok: true }, { 'Set-Cookie': `ffsb=${t}; Path=/; HttpOnly; SameSite=Lax` });
    }
    return json(401, { error: 'bad token' });
  }
  if (!isAuthed(tok)) return json(401, { error: 'unauthorized' });

  const m = (re) => re.exec(url.pathname);
  let r;
  if (url.pathname === '/api/state') return json(200, state);
  if ((r = m(/^\/api\/sessions\/([^/]+)\/events$/))) return json(200, (transcripts[r[1]] ?? []).slice(-Number(url.searchParams.get('limit') ?? 500)));
  if ((r = m(/^\/api\/sessions\/([^/]+)\/message$/))) {
    simulateTurn(r[1], data.text);
    return json(200, { ok: true });
  }
  if ((r = m(/^\/api\/sessions\/([^/]+)\/interrupt$/))) {
    const s = find(r[1]);
    s._interrupted = true;
    return json(200, { ok: true });
  }
  if ((r = m(/^\/api\/sessions\/([^/]+)\/permission$/))) {
    const s = find(r[1]);
    const p = s.pendingPermissions.find((x) => x.requestId === data.requestId);
    s.pendingPermissions = s.pendingPermissions.filter((x) => x.requestId !== data.requestId);
    s.status = 'running';
    const ev = (transcripts[s.id] ?? []).find((e) => e.kind === 'permission' && e.requestId === data.requestId);
    if (ev) {
      ev.decision = data.allow ? 'allow' : 'deny';
      broadcast({ type: 'transcript', sessionId: s.id, event: ev });
    }
    upd(s);
    s._resume?.(data.allow, p);
    return json(200, { ok: true });
  }
  if ((r = m(/^\/api\/sessions\/([^/]+)\/mode$/))) {
    const s = find(r[1]);
    s.permissionMode = data.mode;
    upd(s);
    return json(200, { ok: true });
  }
  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    const id = 'w' + Math.random().toString(36).slice(2, 7);
    const s = session(id, 'worker', data.title || data.prompt.slice(0, 40), { sandboxId: data.sandboxId, model: data.model, permissionMode: data.permissionMode ?? 'default', createdAt: now(), lastActivityAt: now() });
    state.sessions.push(s);
    const sb = state.sandboxes.find((x) => x.id === data.sandboxId);
    sb.sessionIds.push(id);
    broadcast({ type: 'sandbox', sandbox: sb });
    upd(s);
    simulateTurn(id, data.prompt);
    return json(200, s);
  }
  if ((r = m(/^\/api\/sessions\/([^/]+)$/)) && req.method === 'DELETE') {
    state.sessions = state.sessions.filter((x) => x.id !== r[1]);
    for (const sb of state.sandboxes) if (sb.sessionIds.includes(r[1])) {
      sb.sessionIds = sb.sessionIds.filter((x) => x !== r[1]);
      broadcast({ type: 'sandbox', sandbox: sb });
    }
    broadcast({ type: 'session_removed', id: r[1] });
    return json(200, { ok: true });
  }
  if (url.pathname === '/api/orchestrator/reset') {
    transcripts.orch = [];
    return json(200, { ok: true });
  }
  if (url.pathname === '/api/sandboxes' && req.method === 'POST') {
    const id = 'sb' + Math.random().toString(36).slice(2, 7);
    const sb = { id, name: data.name, branch: data.branch ?? `sandbox/${data.name}`, base: data.base ?? 'origin/develop', path: `D:\\ff-sandboxes\\${data.name}`, purpose: data.purpose ?? '', status: 'creating', statusDetail: 'git worktree add…', createdAt: now(), sessionIds: [], unity: { state: 'stopped' } };
    state.sandboxes.push(sb);
    broadcast({ type: 'sandbox', sandbox: sb });
    setTimeout(() => { sb.statusDetail = 'Copying Library seed…'; broadcast({ type: 'sandbox', sandbox: sb }); }, 1500);
    setTimeout(() => { sb.status = 'ready'; delete sb.statusDetail; broadcast({ type: 'sandbox', sandbox: sb }); }, 4000);
    return json(200, sb);
  }
  if ((r = m(/^\/api\/sandboxes\/([^/]+)$/)) && req.method === 'DELETE') {
    const sb = state.sandboxes.find((x) => x.id === r[1]);
    sb.status = 'deleting';
    broadcast({ type: 'sandbox', sandbox: sb });
    setTimeout(() => { state.sandboxes = state.sandboxes.filter((x) => x.id !== r[1]); broadcast({ type: 'sandbox_removed', id: r[1] }); }, 2000);
    return json(200, { ok: true });
  }
  if ((r = m(/^\/api\/sandboxes\/([^/]+)\/unity$/))) {
    const sb = state.sandboxes.find((x) => x.id === r[1]);
    sb.unity = { state: data.action === 'start' ? 'starting' : 'stopping' };
    broadcast({ type: 'sandbox', sandbox: sb });
    setTimeout(() => { sb.unity = data.action === 'start' ? { state: 'running', pid: 4242, startedAt: now() } : { state: 'stopped' }; broadcast({ type: 'sandbox', sandbox: sb }); }, 2500);
    return json(200, { ok: true });
  }
  if ((r = m(/^\/api\/sandboxes\/([^/]+)\/unity-log$/))) {
    return json(200, { lines: Array.from({ length: 60 }, (_, i) => i % 13 === 0 ? `Assets/Scripts/Foo.cs(12,5): error CS1002: ; expected` : i % 7 === 0 ? `Warning: shader variant stripped ${i}` : `[${i}] Refreshing native plugins compatible for Editor in ${i}.4 ms`) });
  }
  json(404, { error: 'not found' });
});

const find = (id) => state.sessions.find((s) => s.id === id);
const upd = (s) => { s.lastActivityAt = now(); broadcast({ type: 'session', session: s }); };
server.on('upgrade', (req, sock, head) => {
  const tok = /ffsb=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  if (!isAuthed(tok)) { sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return sock.destroy(); }
  wss.handleUpgrade(req, sock, head, (ws) => ws.send(JSON.stringify({ type: 'state', state })));
});
function broadcast(ev) {
  const s = JSON.stringify(ev);
  for (const c of wss.clients) c.readyState === 1 && c.send(s);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function simulateTurn(sid, text) {
  const s = find(sid);
  push(sid, { kind: 'user', from: 'human', text });
  s.status = 'running';
  s._interrupted = false;
  upd(s);
  await sleep(600);
  push(sid, { kind: 'thinking', text: 'Considering which sandbox fits this request and whether Unity needs to be running.' });
  const tid = 't' + Math.random().toString(36).slice(2, 7);
  push(sid, { kind: 'tool_use', toolUseId: tid, name: 'mcp__sandboxes__list_sandboxes', input: { includeSessions: true } });
  await sleep(900);
  push(sid, { kind: 'tool_result', toolUseId: tid, isError: false, text: JSON.stringify(state.sandboxes.map((x) => x.name)) });
  if (/perm/i.test(text)) {
    const requestId = 'p' + Math.random().toString(36).slice(2, 7);
    const input = { command: 'rm -rf Library/ScriptAssemblies', description: 'Clear stale assemblies' };
    s.pendingPermissions.push({ requestId, toolName: 'Bash', input, reason: 'Command deletes files', createdAt: now() });
    s.status = 'waiting_permission';
    push(sid, { kind: 'permission', requestId, toolName: 'Bash', input });
    upd(s);
    const allowed = await new Promise((r) => (s._resume = r));
    s._resume = null;
    push(sid, { kind: 'system', text: allowed ? 'Permission granted' : 'Permission denied' });
  }
  const reply = `Here's what I found for **"${text.slice(0, 60)}"**:\n\n- \`shader-work\` is running Unity (pid 18244)\n- \`spec-098\` is still copying its Library seed\n\nI'll start an agent in \`shader-work\` once you confirm. Anything else?`;
  for (const chunk of reply.match(/.{1,6}/gs)) {
    if (s._interrupted) break;
    broadcast({ type: 'delta', sessionId: sid, text: chunk });
    await sleep(35);
  }
  if (s._interrupted) {
    push(sid, { kind: 'result', ok: false, text: 'interrupted', costUsd: 0.01, turns: 1, durationMs: 1400 });
  } else {
    push(sid, { kind: 'assistant', text: reply });
    push(sid, { kind: 'result', ok: true, text: reply, costUsd: 0.07, turns: 2, durationMs: 4200 });
  }
  s.status = 'idle';
  s.turns += 2;
  s.costUsd += 0.07;
  upd(s);
}

setInterval(() => {
  const sys = state.system;
  sys.loadPct = Math.max(3, Math.min(99, sys.loadPct + (Math.random() - 0.5) * 12));
  sys.memFreeBytes = Math.max(2 * 2 ** 30, Math.min(60 * 2 ** 30, sys.memFreeBytes + (Math.random() - 0.5) * 2 ** 30));
  sys.gpu.utilPct = Math.max(0, Math.min(100, sys.gpu.utilPct + (Math.random() - 0.5) * 15));
  broadcast({ type: 'system', system: sys });
}, 2000);

server.listen(PORT, () => console.log(`mock FF Sandboxes backend on http://localhost:${PORT} (token: mock)`));
