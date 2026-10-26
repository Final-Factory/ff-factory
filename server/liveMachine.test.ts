// The live view's machine half (machine/live.ts, w1398): the frame wire, the game's channel file, and a LiveSession
// against a fake game that speaks the real protocol (the game repo's LiveFrameStream).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { FrameParser, LiveSession, ProcessBirths, agentControlDir, readGameChannel, type CommandReply, type GameChannel, type LiveState } from '../machine/live.ts';

const msg = (kind: string, payload: Buffer) => {
  const h = Buffer.alloc(5);
  h.write(kind, 0, 'ascii');
  h.writeUInt32BE(payload.length, 1);
  return Buffer.concat([h, payload]);
};

test('live: the frame parser joins and splits TCP chunks', () => {
  const p = new FrameParser();
  const wire = Buffer.concat([msg('H', Buffer.from('{"game":"finalfactory"}')), msg('F', Buffer.from([1, 2, 3])), msg('F', Buffer.from([4]))]);
  const out: { kind: string; payload: Buffer }[] = [];
  for (let i = 0; i < wire.length; i += 3) out.push(...p.push(wire.subarray(i, i + 3)));
  assert.deepEqual(out.map((m) => m.kind), ['H', 'F', 'F']);
  assert.deepEqual([...out[1].payload], [1, 2, 3]);
  assert.throws(() => new FrameParser().push(Buffer.from([0x46, 0xff, 0xff, 0xff, 0xff])), /not a frame/);
});

test('live: the game channel file and its folder per OS', () => {
  assert.match(agentControlDir('win32', 'C:/Users/x'), /AppData[\\/]LocalLow[\\/]Never Games[\\/]finalfactory[\\/]AgentControl$/);
  assert.match(agentControlDir('darwin', '/Users/x'), /Library[\\/]Application Support[\\/]Never Games/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  fs.writeFileSync(path.join(dir, 'session-42.json'), JSON.stringify({ port: 5123, token: 't', tier: 'all', pid: 42 }));
  assert.deepEqual(readGameChannel(42, dir), { port: 5123, token: 't', tier: 'all', pid: 42 });
  assert.equal(readGameChannel(43, dir), undefined);
});

/** A fake game: answers commands, and on live.frames|on dials the port and streams `frames` JPEG-shaped frames. */
function fakeGame(opts: { tier: string; frames: number }) {
  const commands: string[] = [];
  let tier = opts.tier;
  const ch = (): GameChannel => ({ port: 1, token: 't', tier, pid: 7 });
  const acks: number[] = [];
  const command = async (_c: GameChannel, text: string): Promise<CommandReply> => {
    commands.push(text);
    const m = /^live\.frames\|on\|\d+\|\d+\|(\d+)$/.exec(text);
    if (m) {
      const sock = net.connect(Number(m[1]), '127.0.0.1');
      sock.on('connect', () => {
        sock.write(msg('H', Buffer.from('{"game":"finalfactory","fps":15}')));
        let sent = 0;
        const next = () => {
          if (sent >= opts.frames) return;
          sock.write(msg('F', Buffer.from([0xff, 0xd8, sent])));
          sent++;
        };
        // One in flight: the next frame only after the daemon's 'A', as the game does.
        sock.on('data', (d: Buffer) => {
          for (const b of d) if (b === 0x41) (acks.push(sent), next());
        });
        next();
      });
      sock.on('error', () => undefined);
    }
    return { ok: true, status: 200, result: 'ok' };
  };
  return { commands, ch, command, acks, devTier: async () => ((tier = 'all'), 'tier=all') };
}

test('live: a session takes the dev tier, streams, answers each frame, and keeps going', async () => {
  const game = fakeGame({ tier: 'player-safe', frames: 5 });
  const frames: Buffer[] = [];
  const states: [LiveState, string][] = [];
  const s = new LiveSession(15, 960, {
    editorPid: () => 7,
    channel: () => game.ch(),
    devTier: game.devTier,
    command: game.command,
    frame: (j) => frames.push(j),
    state: (st, d) => states.push([st, d]),
    now: () => Date.now(),
  }, 50);
  await s.start();
  for (let i = 0; i < 100 && frames.length < 5; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(frames.length, 5, 'every frame came, one at a time');
  assert.deepEqual([...frames[4]], [0xff, 0xd8, 4]);
  assert.equal(s.hello?.game, 'finalfactory');
  assert.ok(game.commands.some((c) => c === `live.frames|on|15|960|${s.listenPort}`));
  assert.deepEqual(states.map((x) => x[0]).slice(0, 2), ['starting', 'live']);
  assert.equal((await s.command('look.material.list|VfxComet')).ok, true);
  await s.stop();
  assert.equal(game.commands.at(-1), 'live.frames|off');
  assert.equal(states.at(-1)?.[0], 'stopped');
});

test('live: no editor or no play mode holds, with the reason', async () => {
  const states: [LiveState, string][] = [];
  let pid: number | undefined;
  const s = new LiveSession(15, 960, {
    editorPid: () => pid,
    channel: () => undefined,
    devTier: async () => 'not playing',
    command: async () => ({ ok: false, status: 0, result: '' }),
    frame: () => undefined,
    state: (st, d) => states.push([st, d]),
    now: () => Date.now(),
  }, 30);
  await s.start();
  await new Promise((r) => setTimeout(r, 50));
  pid = 9;
  await new Promise((r) => setTimeout(r, 80));
  await s.stop();
  assert.ok(states.some(([st, d]) => st === 'holding' && /editor is not running/.test(d)));
  assert.ok(states.some(([st, d]) => st === 'holding' && /not in play mode/.test(d)));
  assert.equal((await s.command('look.material.list|X')).ok, false);
});

test('w2255: a session file older than its process is another process\'s under a reused pid, and is not its channel', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  const file = path.join(dir, 'session-2044.json');
  fs.writeFileSync(file, JSON.stringify({ port: 64289, token: 't', tier: 'all', pid: 2044 }));
  // lothdesktop/slot1, 2026-10-26: the file was the 2026-10-14 game's; the editor with that pid started at 06:29Z.
  const stale = new Date('2026-10-14T13:58:35Z');
  fs.utimesSync(file, stale, stale);
  const born = Date.parse('2026-10-26T06:29:00Z');
  assert.equal(readGameChannel(2044, dir, born), undefined);
  assert.equal(readGameChannel(2044, dir)?.port, 64289, 'with no start time, read as before');
  const fresh = new Date(born + 60_000);
  fs.utimesSync(file, fresh, fresh);
  assert.equal(readGameChannel(2044, dir, born)?.port, 64289);

  // ProcessBirths: no channel while the start time is looked up, then the check; an OS that cannot say reads as before.
  let asked = 0;
  const births = new ProcessBirths(async () => (asked++, born + 120_000));
  assert.equal(births.channel(2044, dir), undefined);
  await new Promise((r) => setImmediate(r));
  assert.equal(births.channel(2044, dir), undefined, 'written before this process started');
  assert.equal(asked, 1, 'looked up once');
  const unknown = new ProcessBirths(async () => undefined);
  unknown.channel(2044, dir);
  await new Promise((r) => setImmediate(r));
  assert.equal(unknown.channel(2044, dir)?.port, 64289);
});
