// A stand-in for the game's live view half (w1398; the real one is the game repo's LiveLook.cs), for tests and the E2E
// server: it answers live.frames and look.material.* the way the game does, and streams frames over the real wire (the
// daemon's loopback port, 'H' then 'F' messages, one in flight until the daemon's 'A'). Its frames are small PNGs whose
// colour follows the _Intensity knob, so a knob move shows in the picture. Test-only: no production code imports it.
import net from 'node:net';
import zlib from 'node:zlib';
import type { CommandReply, GameChannel, LiveSessionDeps } from '../machine/live.ts';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Buffer) {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A solid-colour PNG, w x h. */
export function solidPng(w: number, h: number, r: number, g: number, b: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const msg = (kind: string, payload: Buffer) => {
  const h = Buffer.alloc(5);
  h.write(kind, 0, 'ascii');
  h.writeUInt32BE(payload.length, 1);
  return Buffer.concat([h, payload]);
};

interface Knob {
  name: string;
  label: string;
  type: 'range' | 'color' | 'float';
  value: number | number[];
  min?: number;
  max?: number;
  hdr?: boolean;
  driven?: string;
}

const DEFAULTS = (): Record<string, Knob[]> => ({
  VfxComet: [
    { name: '_Intensity', label: 'Overall Intensity', type: 'range', value: 1, min: 0, max: 4 },
    { name: '_ComaColor', label: 'Coma Glow', type: 'color', value: [0.25, 0.9, 1.1, 1], hdr: true },
    // A knob the game says it cannot move (w1509): its presentation system sets it on every draw.
    { name: '_Age', label: 'Comet age (s)', type: 'float', value: 0, driven: 'a script sets it on \'Comet\' per renderer (a MaterialPropertyBlock), which wins over the material; ask the agent to change it in that script' },
  ],
});

/** The fake game: the deps a LiveSession takes for it, plus what it was asked and its knobs' state. */
export function fakeLiveGame(opts: { fps?: number; width?: number; height?: number } = {}) {
  const commands: string[] = [];
  let knobs = DEFAULTS();
  let originals = DEFAULTS();
  let stream: net.Socket | undefined;
  const channel: GameChannel = { port: 0, token: 'fake', tier: 'all', pid: 4242 };
  const frame = () => {
    const i = Number(knobs.VfxComet.find((k) => k.name === '_Intensity')?.value ?? 1);
    const level = Math.max(0, Math.min(255, Math.round((i / 4) * 255)));
    return solidPng(opts.width ?? 64, opts.height ?? 36, level, 64, 255 - level);
  };
  const startStream = (port: number, fps: number) => {
    stream?.destroy();
    const sock = net.connect(port, '127.0.0.1');
    stream = sock;
    sock.on('error', () => undefined);
    sock.on('connect', () => {
      sock.write(msg('H', Buffer.from(JSON.stringify({ game: 'finalfactory', fake: true, fps }))));
      sock.write(msg('F', frame()));
    });
    sock.on('data', (d: Buffer) => {
      // One in flight, as the game: the next frame after the daemon's 'A', at the stream's rate.
      for (const b of d) if (b === 0x41) setTimeout(() => !sock.destroyed && sock.write(msg('F', frame())), 1000 / fps);
    });
  };
  const command = async (_ch: GameChannel, text: string): Promise<CommandReply> => {
    commands.push(text);
    const ok = (result: string): CommandReply => ({ ok: true, status: 200, result });
    const bad = (result: string): CommandReply => ({ ok: false, status: 200, result, reason: 'bad_arguments' });
    const p = text.replace(/^ffauto:/, '').split('|');
    switch (p[0]) {
      case 'live.frames':
        if (p[1] === 'on') {
          startStream(Number(p[4]), Number(p[2]) || 10);
          return ok(`live frames on fps=${p[2]} width=${p[3]} port=${p[4]}`);
        }
        stream?.destroy();
        stream = undefined;
        return ok('live frames off');
      case 'look.material.list': {
        const list = knobs[p[1]];
        return list ? ok(JSON.stringify({ material: p[1], shader: 'FinalFactory/VfxComet', knobs: list })) : bad(`no loaded material named '${p[1]}'.`);
      }
      case 'look.material.set': {
        const k = knobs[p[1]]?.find((x) => x.name === p[2]);
        if (!k) return bad(`'${p[1]}' has no knob '${p[2]}'`);
        const nums = String(p[3] ?? '').split(',').map(Number);
        k.value = k.type === 'color' ? [...nums, 1].slice(0, 4) : nums[0];
        return ok(JSON.stringify({ ...k, moved: true }));
      }
      case 'look.material.reset':
        knobs = DEFAULTS();
        originals = DEFAULTS();
        return ok('reset 1 knob(s)');
      default:
        return bad(`unknown ${p[0]}`);
    }
  };
  const deps: Partial<LiveSessionDeps> = {
    editorPid: () => channel.pid,
    channel: () => channel,
    devTier: async () => 'tier=all',
    command,
  };
  return { deps, commands, knobs: () => knobs, originals: () => originals, stop: () => stream?.destroy() };
}
