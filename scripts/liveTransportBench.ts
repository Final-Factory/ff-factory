// w1601 transport bench: source frames -> daemon pump -> [link A] -> portal LiveHub (real code from --repo) ->
// [link B] -> viewer (newest wins, decode delay, answers frames when --acks). Links are TCP proxies with a bandwidth
// cap, a one-way delay each way and a bottleneck queue.
// node bench/transport.ts --repo <ff-factory dir> --mode before|after --fps 15 --kb 64 --bmbit 10 --brtt 128 --secs 20
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const repo = arg('repo', '.');
const mode = arg('mode', 'after');
const fps = Number(arg('fps', '15'));
const kb = Number(arg('kb', '64'));
const aMbit = Number(arg('ambit', '40'));
const aRtt = Number(arg('artt', '20'));
const bMbit = Number(arg('bmbit', '10'));
const bRtt = Number(arg('brtt', '128'));
const queueKb = Number(arg('qkb', '256'));
const decodeMs = Number(arg('decode', '8'));
const secs = Number(arg('secs', '20'));
const warm = 3;

const { LiveHub } = await import(pathToFileURL(path.join(repo, 'server/live.ts')).href);
const pumpMod = mode === 'after' ? await import(pathToFileURL(path.join(repo, 'shared/framePump.ts')).href) : undefined;

// ---------------------------------------------------------------- link emulation
function shaped(src: net.Socket, dst: net.Socket, bytesPerMs: number, delayMs: number, queueMax: number) {
  let nextFree = 0;
  let queued = 0;
  const out: { at: number; chunk: Buffer }[] = [];
  let timer: NodeJS.Timeout | undefined;
  const drain = () => {
    timer = undefined;
    const now = performance.now();
    while (out.length && out[0].at <= now + 0.5) dst.write(out.shift()!.chunk);
    if (out.length) timer = setTimeout(drain, Math.max(0, out[0].at - now));
  };
  src.on('data', (chunk: Buffer) => {
    const now = performance.now();
    const start = Math.max(now, nextFree);
    nextFree = start + chunk.length / bytesPerMs;
    queued += chunk.length;
    if (queued > queueMax) src.pause();
    const departs = nextFree;
    setTimeout(() => {
      queued -= chunk.length;
      if (queued <= queueMax && src.isPaused()) src.resume();
    }, Math.max(0, departs - now));
    out.push({ at: departs + delayMs, chunk });
    if (!timer) timer = setTimeout(drain, Math.max(0, out[0].at - now));
  });
  src.on('close', () => dst.destroy());
  src.on('error', () => dst.destroy());
}

/** A proxy to `port`: `bulk` says which way the cap applies ('up' client->server, 'down' server->client). */
function link(port: number, mbit: number, rttMs: number, bulk: 'up' | 'down'): Promise<number> {
  const bpm = (mbit * 1e6) / 8 / 1000;
  const fast = (1000 * 1e6) / 8 / 1000;
  const srv = net.createServer((c) => {
    c.setNoDelay(true);
    const u = net.connect(port, '127.0.0.1');
    u.setNoDelay(true);
    shaped(c, u, bulk === 'up' ? bpm : fast, rttMs / 2, bulk === 'up' ? queueKb * 1024 : 1 << 30);
    shaped(u, c, bulk === 'down' ? bpm : fast, rttMs / 2, bulk === 'down' ? queueKb * 1024 : 1 << 30);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as net.AddressInfo).port)));
}

// ---------------------------------------------------------------- portal (real LiveHub)
const info = { id: 's1', machineId: 'm1', machineSandbox: 'slot1' } as never;
const hub = new LiveHub({
  enabled: () => true,
  machines: { canLive: () => true, live: async () => 'ok' },
  session: () => info,
  roleOf: () => 'owner',
  changed: () => undefined,
});
await hub.tool(info, { action: 'start', fps, width: 960 });
const liveId: string = hub.viewsFor('u1')[0].liveId;
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const server = http.createServer();
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (req.url!.startsWith('/machine/live/')) hub.attachFrames('m1', liveId, ws);
    else hub.addViewer('s1', ws);
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const portalPort = (server.address() as net.AddressInfo).port;
const aPort = await link(portalPort, aMbit, aRtt, 'up');
const bPort = await link(portalPort, bMbit, bRtt, 'down');

// ---------------------------------------------------------------- daemon
const dws = new WebSocket(`ws://127.0.0.1:${aPort}/machine/live/${liveId}`, { perMessageDeflate: false });
await new Promise((r) => dws.once('open', r));
let push: (f: Buffer) => void;
if (pumpMod) {
  const pump = new pumpMod.FramePump({
    send: (f: Buffer) => dws.send(f, { binary: true, compress: false }),
    buffered: () => (dws.readyState === WebSocket.OPEN ? dws.bufferedAmount : -1),
    now: () => Date.now(),
    later: (fn: () => void, ms: number) => void setTimeout(fn, ms),
  });
  dws.on('message', (d, bin) => {
    if (bin) return;
    const n = pumpMod.parseAck(String(d));
    if (n !== undefined) pump.ack(n);
  });
  push = (f) => pump.push(f);
} else {
  // The pre-w1601 daemon's pumpLive, verbatim in effect.
  let latest: Buffer | undefined;
  const pumpLive = () => {
    if (!latest || dws.readyState !== WebSocket.OPEN) return;
    if (dws.bufferedAmount > 256 * 1024) {
      setTimeout(pumpLive, 20);
      return;
    }
    const f = latest;
    latest = undefined;
    dws.send(f, { binary: true, compress: false });
  };
  push = (f) => {
    latest = f;
    pumpLive();
  };
}

// ---------------------------------------------------------------- viewer
const lat: number[] = [];
let drawn = 0;
let arrived = 0;
const t0 = performance.now();
const vws = new WebSocket(`ws://127.0.0.1:${bPort}/live/s1`, { perMessageDeflate: false });
await new Promise((r) => vws.once('open', r));
let pending: { buf: Buffer; no: number } | undefined;
let decoding = false;
let received = 0;
const decodeNext = () => {
  if (decoding || !pending) return;
  decoding = true;
  const p = pending;
  pending = undefined;
  setTimeout(() => {
    decoding = false;
    const sentAt = p.buf.readDoubleLE(8);
    const now = performance.now();
    if (now - t0 > warm * 1000) {
      drawn++;
      lat.push(now - sentAt);
    }
    if (mode === 'after') vws.send(`a${p.no}`);
    decodeNext();
  }, decodeMs);
};
vws.on('message', (d: Buffer, bin) => {
  if (!bin) return;
  arrived++;
  pending = { buf: d, no: ++received };
  decodeNext();
});

// ---------------------------------------------------------------- source
let seq = 0;
const src = setInterval(() => {
  const size = Math.round(kb * 1024 * (0.85 + Math.random() * 0.3));
  const f = Buffer.alloc(size);
  f.write('BNCH', 0);
  f.writeUInt32LE(++seq, 4);
  f.writeDoubleLE(performance.now(), 8);
  push(f);
}, 1000 / fps);

await new Promise((r) => setTimeout(r, secs * 1000));
clearInterval(src);
lat.sort((a, b) => a - b);
const q = (p: number) => Math.round(lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] ?? NaN);
const span = secs - warm;
const status = await hub.tool(info, { action: 'status' });
console.log(
  JSON.stringify({
    mode,
    fps,
    kb,
    link_b: `${bMbit} Mbit/s ${bRtt} ms`,
    link_a: `${aMbit} Mbit/s ${aRtt} ms`,
    offered_mbit: Math.round(((fps * kb * 1024 * 8) / 1e6) * 10) / 10,
    drawn_fps: Math.round((drawn / span) * 10) / 10,
    latency_ms: { p50: q(0.5), p95: q(0.95), max: Math.round(lat[lat.length - 1] ?? NaN) },
    sent: seq,
    arrived,
    status: mode === 'after' ? status.replace(/^.*?Watching: /, '') : undefined,
  }),
);
process.exit(0);
