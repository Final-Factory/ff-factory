// w1601 Live view bench with the real game: a sandbox editor in play mode streams through the real daemon half
// (machine/live.ts LiveSession) and the real portal half (server/live.ts LiveHub, from --repo, so an older checkout
// measures the "before"), over shaped links (link A: daemon to portal, link B: portal to the page), to a headless
// Chromium page that decodes and draws frames the way web/src/components/LiveStage.tsx does. Every --flip seconds it
// hides or shows the game's HUD (ffauto:ui.hide) and times the first drawn frame that shows the change.
//
// node scripts/liveLatencyBench.ts --repo <ff-factory dir> --mode before|after --pid <editor pid> --fps 15 --width 960
//   [--ambit 40 --artt 20] [--bmbit 10 --brtt 128] [--secs 60] [--flip 3] [--browser chromium|webkit] [--out <dir>] [--video <dir>]
// It needs the editor in play mode in a game, with its agent channel in the dev tier (DEV_TIER_SNIPPET).
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import { chromium, webkit } from '@playwright/test';
import { LiveSession, gameCommand, readGameChannel } from '../machine/live.ts';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const repo = path.resolve(arg('repo', '.'));
const mode = arg('mode', 'after');
const pid = Number(arg('pid', '0'));
const fps = Number(arg('fps', '15'));
const width = Number(arg('width', '960'));
const aMbit = Number(arg('ambit', '40'));
const aRtt = Number(arg('artt', '20'));
const bMbit = Number(arg('bmbit', '100'));
const bRtt = Number(arg('brtt', '128'));
const queueKb = Number(arg('qkb', '256'));
const secs = Number(arg('secs', '60'));
const flipS = Number(arg('flip', '3'));
const browserName = arg('browser', 'chromium');
const out = arg('out', '');
const video = arg('video', '');

const { LiveHub } = await import(pathToFileURL(path.join(repo, 'server/live.ts')).href);
const after = mode.startsWith('after');
const pumpMod = after ? await import(pathToFileURL(path.join(repo, 'shared/framePump.ts')).href) : undefined;

// ---------------------------------------------------------------- link emulation (as scripts/liveTransportBench.ts)
function shaped(src: net.Socket, dst: net.Socket, bytesPerMs: number, delayMs: number, queueMax: number) {
  let nextFree = 0;
  let queued = 0;
  const q: { at: number; chunk: Buffer }[] = [];
  let timer: NodeJS.Timeout | undefined;
  const drain = () => {
    timer = undefined;
    const now = performance.now();
    while (q.length && q[0].at <= now + 0.5) dst.write(q.shift()!.chunk);
    if (q.length) timer = setTimeout(drain, Math.max(0, q[0].at - now));
  };
  src.on('data', (chunk: Buffer) => {
    const now = performance.now();
    nextFree = Math.max(now, nextFree) + chunk.length / bytesPerMs;
    queued += chunk.length;
    if (queued > queueMax) src.pause();
    setTimeout(() => {
      queued -= chunk.length;
      if (queued <= queueMax && src.isPaused()) src.resume();
    }, Math.max(0, nextFree - now));
    q.push({ at: nextFree + delayMs, chunk });
    if (!timer) timer = setTimeout(drain, Math.max(0, q[0].at - now));
  });
  src.on('close', () => dst.destroy());
  src.on('error', () => dst.destroy());
}
function link(port: number, mbit: number, rttMs: number, bulk: 'up' | 'down'): Promise<number> {
  const bpm = (mbit * 1e6) / 8 / 1000;
  const fast = 1e9 / 8 / 1000;
  const srv = net.createServer((c) => {
    c.setNoDelay(true);
    const u = net.connect(port, '127.0.0.1');
    u.setNoDelay(true);
    shaped(c, u, bulk === 'up' ? bpm : fast, rttMs / 2, bulk === 'up' ? queueKb * 1024 : 1 << 30);
    shaped(u, c, bulk === 'down' ? bpm : fast, rttMs / 2, bulk === 'down' ? queueKb * 1024 : 1 << 30);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as net.AddressInfo).port)));
}

// ---------------------------------------------------------------- the page (LiveStage's loop, plus a probe)
const PAGE = `<!doctype html><body style="margin:0;background:#000"><canvas id=c style="width:100vw;height:100vh;object-fit:contain"></canvas><div id=l style="position:fixed;left:8px;bottom:8px;font:bold 22px sans-serif;color:#ff0;background:#000a;padding:4px 8px"></div><script>
const p = new URLSearchParams(location.search); const ack = p.get('ack') === '1';
const c = document.getElementById('c'); const ctx = c.getContext('2d');
const probe = document.createElement('canvas'); probe.width = 32; probe.height = 18;
const pctx = probe.getContext('2d', { willReadFrequently: true });
let pending = null, pendingNo = 0, received = 0, decoding = false;
const ws = new WebSocket(p.get('ws')); ws.binaryType = 'blob';
ws.onmessage = (m) => { if (!(m.data instanceof Blob)) return; window.arrived(Date.now()); pending = m.data; pendingNo = ++received; pump(); };
async function pump() {
  if (decoding) return; decoding = true;
  while (pending) {
    const blob = pending, no = pendingNo; pending = null;
    const t0 = performance.now(); let bmp;
    try { bmp = await createImageBitmap(blob); } catch { if (ack) ws.send('a' + no); continue; }
    const dec = performance.now() - t0;
    if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height; }
    ctx.drawImage(bmp, 0, 0); pctx.drawImage(bmp, 0, 0, 32, 18); bmp.close();
    if (ack) ws.send('a' + no);
    const d = pctx.getImageData(0, 0, 32, 18).data; const v = [];
    for (let i = 0; i < d.length; i += 4) v.push((d[i] + d[i + 1] + d[i + 2]) / 3);
    window.drawn(Date.now(), dec, blob.size, v);
  }
  decoding = false;
}
</script>`;

// ---------------------------------------------------------------- portal (real LiveHub)
const info = { id: 's1', machineId: 'm1', machineSandbox: 'slot1' } as never;
const hub = new LiveHub({ enabled: () => true, machines: { canLive: () => true, live: async () => 'ok' }, session: () => info, roleOf: () => 'owner', changed: () => undefined });
await hub.tool(info, { action: 'start', fps, width });
const liveId: string = hub.viewsFor('u1')[0].liveId;
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
server.on('upgrade', (req, socket, head) =>
  wss.handleUpgrade(req, socket, head, (ws) => (req.url!.startsWith('/machine/live/') ? hub.attachFrames('m1', liveId, ws) : hub.addViewer('s1', ws))),
);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const portalPort = (server.address() as net.AddressInfo).port;
const aPort = await link(portalPort, aMbit, aRtt, 'up');
const bPort = await link(portalPort, bMbit, bRtt, 'down');

// ---------------------------------------------------------------- daemon half (real LiveSession; the link as the daemon's)
const dws = new WebSocket(`ws://127.0.0.1:${aPort}/machine/live/${liveId}`, { perMessageDeflate: false });
await new Promise((r) => dws.once('open', r));
let toPortal: (f: Buffer) => void;
if (pumpMod) {
  const pump = new pumpMod.FramePump({
    send: (f: Buffer) => dws.send(f, { binary: true, compress: false }),
    buffered: () => (dws.readyState === WebSocket.OPEN ? dws.bufferedAmount : -1),
    now: () => Date.now(),
    later: (fn: () => void, ms: number) => void setTimeout(fn, ms),
  });
  dws.on('message', (d, bin) => {
    const n = bin ? undefined : pumpMod.parseAck(String(d));
    if (n !== undefined) pump.ack(n);
  });
  toPortal = (f) => pump.push(f);
} else {
  let latest: Buffer | undefined;
  const pumpLive = () => {
    if (!latest || dws.readyState !== WebSocket.OPEN) return;
    if (dws.bufferedAmount > 256 * 1024) return void setTimeout(pumpLive, 20);
    const f = latest;
    latest = undefined;
    dws.send(f, { binary: true, compress: false });
  };
  toPortal = (f) => {
    latest = f;
    pumpLive();
  };
}
let gameFrames = 0;
let bytes = 0;
const session = new LiveSession(fps, width, {
  editorPid: () => pid,
  channel: (p) => readGameChannel(p),
  devTier: async () => 'set it before the bench (DEV_TIER_SNIPPET)',
  command: (ch, text) => gameCommand(ch, text),
  frame: (jpeg) => {
    gameFrames++;
    bytes += jpeg.length;
    toPortal(jpeg);
  },
  state: (s, d) => console.error(`[live] ${s}: ${d}`),
  now: () => Date.now(),
});
await session.start();

// ---------------------------------------------------------------- the page
const browser = await (browserName === 'webkit' ? webkit : chromium).launch();
// --video <dir>: a 960x540 recording of the page, the view as a person sees it (the before/after clip).
const context = await browser.newContext({
  viewport: { width: 960, height: 540 },
  recordVideo: video ? { dir: video, size: { width: 960, height: 540 } } : undefined,
});
const page = await context.newPage();
const drawn: { at: number; dec: number; size: number; v: number[] }[] = [];
const arrivals: number[] = [];
await page.exposeFunction('drawn', (at: number, dec: number, size: number, v: number[]) => void drawn.push({ at, dec, size, v }));
await page.exposeFunction('arrived', (at: number) => void arrivals.push(at));
await page.goto(`http://127.0.0.1:${portalPort}/?ack=${after ? 1 : 0}&ws=${encodeURIComponent(`ws://127.0.0.1:${bPort}/live/s1`)}`);

// ---------------------------------------------------------------- flips
const ch = () => readGameChannel(pid);
const flips: { at: number; replied: number; hidden: boolean }[] = [];
let hidden = true;
await gameCommand(ch()!, 'ui.hide|true');
const t0 = Date.now();
await new Promise((r) => setTimeout(r, 4000));
const startStats = { frames: gameFrames, drawn: drawn.length, at: Date.now() };
const gameStart = await gameCommand(ch()!, 'live.frames');
while (Date.now() - t0 < secs * 1000) {
  hidden = !hidden;
  const at = Date.now();
  // The label changes when the game is asked; the picture follows when the frame arrives (the lag, on the clip).
  void page.evaluate((t) => (document.getElementById('l')!.textContent = t), `${mode}: asked the game to ${hidden ? 'HIDE' : 'SHOW'} its HUD`);
  const r = await gameCommand(ch()!, `ui.hide|${hidden}`);
  flips.push({ at, replied: Date.now(), hidden });
  if (!r.ok) console.error(`[flip] ${r.result}`);
  await new Promise((res) => setTimeout(res, flipS * 1000));
}
const endStats = { frames: gameFrames, drawn: drawn.length, at: Date.now() };
const gameEnd = await gameCommand(ch()!, 'live.frames');
await gameCommand(ch()!, 'ui.hide|true');
const viewers = await hub.tool(info, { action: 'status' });

// ---------------------------------------------------------------- latency: the first drawn frame in the new state
// References: the mean probe vector of frames drawn in the last second before each flip, per state.
const mean = (vs: number[][]) => vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length);
const settled = (h: boolean) =>
  flips.flatMap((f, i) => {
    const next = flips[i + 1]?.at ?? endStats.at;
    return f.hidden === h ? drawn.filter((d) => d.at > next - 1000 && d.at < next).map((d) => d.v) : [];
  });
const refHidden = mean(settled(true));
const refShown = mean(settled(false));
const dist = (a: number[], b: number[]) => a.reduce((s, x, i) => s + Math.abs(x - b[i]), 0);
const isHidden = (v: number[]) => dist(v, refHidden) < dist(v, refShown);
const lat: number[] = [];
for (const [i, f] of flips.entries()) {
  const until = flips[i + 1]?.at ?? endStats.at;
  const d = drawn.find((x) => x.at > f.at && x.at < until && isHidden(x.v) === f.hidden);
  if (d) lat.push(d.at - f.at);
}
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const pct = (xs: number[], p: number) => Math.round(sorted(xs)[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? NaN);
const span = (endStats.at - startStats.at) / 1000;
const dec = drawn.slice(10).map((d) => d.dec);
const result = {
  mode,
  browser: browserName,
  fps,
  width,
  link_a: `${aMbit} Mbit/s ${aRtt} ms`,
  link_b: `${bMbit} Mbit/s ${bRtt} ms`,
  game_to_daemon_fps: Math.round(((endStats.frames - startStats.frames) / span) * 10) / 10,
  drawn_fps: Math.round(((endStats.drawn - startStats.drawn) / span) * 10) / 10,
  frame_kb: Math.round(bytes / Math.max(1, gameFrames) / 1024),
  decode_ms: { p50: Math.round(pct(dec, 0.5) * 10) / 10, p95: Math.round(pct(dec, 0.95) * 10) / 10 },
  flip_latency_ms: { n: lat.length, of: flips.length, p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: Math.round(Math.max(...lat)) },
  channel_ms: pct(flips.map((f) => f.replied - f.at), 0.5),
  game_status_end: gameEnd.result,
  game_status_start: gameStart.result,
  viewers: String(viewers).replace(/^.*?(Watching|Nobody)/, '$1'),
};
console.log(JSON.stringify(result));
if (out) fs.writeFileSync(path.join(out, `${mode}-${fps}-${width}-${bMbit}.json`), JSON.stringify({ result, flips, lat }, null, 1));
await context.close();
await browser.close();
await session.stop();
process.exit(0);
