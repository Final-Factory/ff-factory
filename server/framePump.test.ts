// The live view's frame pump (shared/framePump.ts, w1601): newest wins, the old buffer cap for a far end that does not
// answer, and a window of one round trip for one that does, so a slow link to a page never queues seconds of frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FramePump, LEGACY_BUFFER_BYTES, MAX_UNACKED_FRAMES, parseAck } from '../shared/framePump.ts';

function rig() {
  let now = 0;
  const sent: number[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  const io = { buffered: 0 };
  const pump = new FramePump({
    send: (f) => void sent.push(f[0]),
    buffered: () => io.buffered,
    now: () => now,
    later: (fn, ms) => void timers.push({ at: now + ms, fn }),
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.splice(0).filter((x) => x.at <= now || !timers.push(x))) t.fn();
  };
  const frame = (id: number, bytes = 1000) => {
    const b = new Uint8Array(bytes);
    b[0] = id;
    return b;
  };
  return { pump, sent, io, advance, frame, at: () => now };
}

test('w1601: parseAck takes "a<count>" and nothing else', () => {
  assert.equal(parseAck('a12'), 12);
  assert.equal(parseAck('a0'), 0);
  assert.equal(parseAck('ack'), undefined);
  assert.equal(parseAck('a-1'), undefined);
  assert.equal(parseAck('12'), undefined);
});

test('w1601: a far end that never answers keeps the old buffer cap, and the newest frame goes once it drains', () => {
  const r = rig();
  r.pump.push(r.frame(1));
  r.io.buffered = LEGACY_BUFFER_BYTES + 1;
  r.pump.push(r.frame(2));
  r.pump.push(r.frame(3));
  assert.deepEqual(r.sent, [1], 'held while the socket is full');
  r.io.buffered = 0;
  r.advance(20);
  assert.deepEqual(r.sent, [1, 3], 'the newest, never the one it replaced');
  assert.equal(r.pump.stats.skipped, 1);
  for (let i = 4; i < 4 + 3 * MAX_UNACKED_FRAMES; i++) r.pump.push(r.frame(i));
  assert.equal(r.sent.length, 2 + 3 * MAX_UNACKED_FRAMES, 'no answers: no window');
});

test('w1601: with answers it keeps to its window and sends the newest frame on each answer', () => {
  const r = rig();
  r.pump.push(r.frame(1));
  r.pump.push(r.frame(2));
  assert.deepEqual(r.sent, [1, 2], 'before any answer the old cap holds');
  r.advance(100);
  r.pump.ack(1); // the first answer: frame 1 took 100 ms
  assert.equal(r.pump.acking, true);
  assert.equal(r.pump.stats.rttMs, 100);
  r.pump.push(r.frame(3));
  r.pump.push(r.frame(4));
  r.pump.push(r.frame(5));
  // Window: 1000 bytes in 100 ms is 10 KB/s, times 100 ms is 1000 bytes, plus a frame: two frames in flight.
  assert.deepEqual(r.sent, [1, 2, 3], 'frame 2 and 3 in flight fill the window');
  assert.equal(r.pump.stats.skipped, 1, 'frame 4 was replaced by 5 while it waited');
  r.advance(50);
  r.pump.ack(2);
  assert.deepEqual(r.sent, [1, 2, 3, 5], 'an answer lets the newest frame go');
  r.pump.ack(1);
  r.pump.ack(2);
  assert.equal(r.pump.acked, 2, 'an old count changes nothing');
});

test('w1601: one frame always goes when nothing is in flight, however big', () => {
  const r = rig();
  r.pump.push(r.frame(1, 100));
  r.advance(10);
  r.pump.ack(1);
  r.pump.push(r.frame(2, 1_000_000));
  assert.deepEqual(r.sent, [1, 2]);
});

test('w1601: a new socket starts its count from zero and without answers', () => {
  const r = rig();
  r.pump.push(r.frame(1));
  r.advance(10);
  r.pump.ack(1);
  r.pump.reset();
  assert.equal(r.pump.acking, false);
  assert.equal(r.pump.sent, 0);
  r.pump.push(r.frame(2));
  r.pump.push(r.frame(3));
  assert.deepEqual(r.sent, [1, 2, 3]);
  r.pump.flush();
  assert.equal(r.sent.length, 3, 'nothing waiting: flush sends nothing');
});

/**
 * A slow link to the page, simulated: frames every 66 ms (15 fps, 64 KB) onto a 5 Mbit/s link with a 128 ms round
 * trip, which carries about 9.5 of them a second. The page answers each frame when it has it. With the pump the
 * frames never queue up: a drawn frame is at most a round trip, three frames on the link and one interval old (the
 * window counts one frame on the link twice), where before w1601 the age grew to seconds.
 */
test('w1601: on a link slower than the stream the view stays within about a round trip of the game', () => {
  let now = 0;
  const bytesPerMs = 5e6 / 8 / 1000;
  const oneWay = 64;
  let linkFree = 0;
  const arrivals: { at: number; born: number }[] = [];
  const born = new Map<number, number>();
  let n = 0;
  const events: { at: number; fn: () => void }[] = [];
  const schedule = (at: number, fn: () => void) => {
    events.push({ at, fn });
    events.sort((a, b) => a.at - b.at);
  };
  let pageCount = 0;
  const pump = new FramePump({
    send: (f) => {
      const id = new DataView(f.buffer).getUint32(0);
      const departs = Math.max(now, linkFree) + f.byteLength / bytesPerMs;
      linkFree = departs;
      schedule(departs + oneWay, () => {
        arrivals.push({ at: now, born: born.get(id)! });
        pageCount++;
        const c = pageCount;
        schedule(now + oneWay, () => pump.ack(c));
      });
    },
    buffered: () => 0,
    now: () => now,
    later: (fn, ms) => schedule(now + ms, fn),
  });
  for (let t = 0; t < 20_000; t += 66) {
    schedule(t, () => {
      const f = new Uint8Array(64 * 1024);
      new DataView(f.buffer).setUint32(0, ++n);
      born.set(n, now);
      pump.push(f);
    });
  }
  while (events.length) {
    const e = events.shift()!;
    now = e.at;
    e.fn();
  }
  const late = arrivals.filter((a) => a.at > 5000).map((a) => a.at - a.born);
  const worst = Math.max(...late);
  const fps = late.length / 15;
  assert.ok(worst < 128 + 3 * ((64 * 1024) / bytesPerMs) + 66 + 10, `worst age ${Math.round(worst)} ms`);
  assert.ok(fps > 6, `it still carries most of what the link can: ${fps.toFixed(1)} fps`);
});
