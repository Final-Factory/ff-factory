import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LineTail } from '../machine/agentHost.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'w6595-tail-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('w6595: a tail that keeps its file open forwards every line, in order, across polls and reopens', async () => {
  const dir = tmp();
  const f = path.join(dir, 'out.jsonl');
  fs.writeFileSync(f, '');
  const got: string[] = [];
  const t = new LineTail(f, (l) => got.push(l), 0, 60);
  const want: string[] = [];
  for (let i = 0; i < 40; i++) {
    const line = `line ${i}`;
    want.push(line);
    // half a line, then the rest: only whole lines are forwarded
    fs.appendFileSync(f, line.slice(0, 3));
    t.poll();
    fs.appendFileSync(f, line.slice(3) + '\n');
    t.poll();
    if (i % 10 === 9) await sleep(80); // past keepOpenMs: the next poll opens the file again
  }
  t.close();
  assert.deepEqual(got, want);
  assert.equal(t.position, fs.statSync(f).size);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('w6595: the kept handle is let go by close() and by itself after keepOpenMs, so its folder can go', async () => {
  for (const how of ['close', 'timer'] as const) {
    const dir = tmp();
    const f = path.join(dir, 'out.jsonl');
    fs.writeFileSync(f, 'a\n');
    const got: string[] = [];
    const t = new LineTail(f, (l) => got.push(l), 0, 50);
    t.poll();
    assert.equal((t as unknown as { fd?: number }).fd !== undefined, true, 'held after a poll');
    if (how === 'close') t.close();
    else await sleep(120);
    assert.equal((t as unknown as { fd?: number }).fd, undefined, `${how}: let go`);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(fs.existsSync(dir), false, `${how}: the folder went`);
    assert.deepEqual(got, ['a']);
  }
});

test('w6595: a tail without keepOpenMs opens and closes the file at each poll, as before', () => {
  const dir = tmp();
  const f = path.join(dir, 'out.jsonl');
  fs.writeFileSync(f, 'x\n');
  const got: string[] = [];
  const t = new LineTail(f, (l) => got.push(l));
  t.poll();
  assert.equal((t as unknown as { fd?: number }).fd, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(got, ['x']);
  t.poll(); // gone: ENOENT, nothing said
  assert.deepEqual(got, ['x']);
});

test('w6595: a line whose handler closes the tail (a host that ended) mid-read still gets the lines after it, and the handle goes', () => {
  const dir = tmp();
  const f = path.join(dir, 'out.jsonl');
  fs.writeFileSync(f, 'one\ntwo\nthree\n');
  const got: string[] = [];
  const t: LineTail = new LineTail(
    f,
    (l) => {
      got.push(l);
      if (l === 'one') {
        t.close();
        t.poll(); // read again from inside a handler, as ended paths do
      }
    },
    0,
    5000,
  );
  t.poll();
  assert.deepEqual(got, ['one', 'two', 'three']);
  t.close();
  assert.equal((t as unknown as { fd?: number }).fd, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false);
});
