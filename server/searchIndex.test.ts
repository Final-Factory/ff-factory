// w5111: the indexed search (server/searchIndex.ts) answers as the plain scan it replaced did, on a made-up corpus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { TranscriptIndex, type RawHit } from './searchIndex.ts';
import { searchTranscripts } from './search.ts';
import { matchLine, prefilterParts, searchableText, snippet, terms } from './searchText.ts';
import { HELD_MARK } from '../shared/conditional.ts';
import type { SessionInfo } from '../shared/types.ts';

/** The reference's reads, kept while a file is unchanged, so hundreds of queries stay quick. */
const readCache = new Map<string, [string, string][]>();

/** The search before w5111, line for line (server/search.ts at 75a58c49), without its mtime shortcut and its slices: every file read whole. */
function plainScan(dir: string, q: { q: string; sessionIds?: Set<string>; since?: number; until?: number; limit: number }): RawHit[] {
  const words = terms(q.q);
  if (!words.length) return [];
  const since = q.since ?? -Infinity;
  const until = q.until ?? Infinity;
  const parts = [...new Set(words.flatMap((w) => w.split(' ')))].filter((w) => w && !/["\\]/.test(w));
  const hits: RawHit[] = [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.gz'));
  const names = new Set(files);
  for (const f of files) {
    const sessionId = f.replace(/\.jsonl(\.gz)?$/, '');
    if (f.endsWith('.gz') && names.has(`${sessionId}.jsonl`)) continue;
    if (q.sessionIds && !q.sessionIds.has(sessionId)) continue;
    const file = path.join(dir, f);
    const st = fs.statSync(file);
    const key = `${file}|${st.ino}|${st.size}|${st.mtimeMs}`;
    let lines = readCache.get(key);
    if (!lines) {
      const raw = f.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : fs.readFileSync(file, 'utf8');
      readCache.set(key, (lines = raw.split('\n').map((line) => [line, line.toLowerCase()])));
    }
    for (const [line, lower] of lines) {
      if (!line) continue;
      if (!parts.every((w) => lower.includes(w))) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const t = Date.parse(e.t);
      if (t < since || t > until) continue;
      const text = searchableText(e) ?? '';
      const tl = text.replace(/\s+/g, ' ').toLowerCase();
      if (!words.every((w) => tl.includes(w))) continue;
      hits.push({ sessionId, seq: e.seq, t: e.t, kind: e.kind, snippet: snippet(text, words) });
    }
  }
  hits.sort((a, b) => b.t.localeCompare(a.t));
  return hits.slice(0, q.limit);
}

/** A small seeded generator, so a failure repeats. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const VOCAB = (
  'belt splitter assembler miner smelter furnace drone hauler station mass driver laser turret shield reactor fuel ' +
  'merge gate test selection timeout bench ticket release build player editor sandbox worker orchestrator dispatcher ' +
  'w5111 w2044 #4158 PR deploy portal index chunk trigram signature null reference Tick() BeltSystem grep Assets ' +
  'Ünïcödé naïve café Straße ΣΟΦΙΑ İstanbul 日本語 emoji🙂 "quoted" back\\slash tab\there new\nline x y z ab'
).split(' ');

function corpus(dir: string, seed: number) {
  const r = rng(seed);
  const pick = () => VOCAB[Math.floor(r() * VOCAB.length)];
  const sentence = (n: number) => Array.from({ length: n }, pick).join(' ');
  let clock = Date.parse('2026-09-01T00:00:00Z');
  const ids = Array.from({ length: 24 }, (_, i) => `s${i}`);
  const seqs = new Map<string, number>();
  const event = (id: string) => {
    clock += 1 + Math.floor(r() * 60_000); // every time differs: the order of ties is not what this test checks
    const seq = (seqs.get(id) ?? 0) + 1;
    seqs.set(id, seq);
    const t = new Date(clock).toISOString();
    const k = r();
    if (k < 0.15) return { seq, t, kind: 'tool_use', toolUseId: `u${seq}`, name: 'Bash', input: { command: sentence(6), t: '2026-01-01T00:00:00Z' } };
    if (k < 0.3) return { seq, t, kind: 'tool_result', toolUseId: `u${seq}`, text: sentence(20 + Math.floor(r() * 400)) };
    if (k < 0.4) return { seq, t, kind: 'user', from: 'human', text: `${sentence(8)}\n\n${HELD_MARK}\n- notes: ${sentence(5)}` };
    if (k < 0.45) return { t, seq, kind: 'permission', toolName: 'Edit', input: { file: sentence(2) } };
    return { seq, t, kind: r() < 0.5 ? 'assistant' : 'thinking', text: sentence(5 + Math.floor(r() * 60)) };
  };
  const lines = new Map<string, string[]>(ids.map((id) => [id, []]));
  // Two transcripts big enough for several chunks, the rest small.
  for (let i = 0; i < 4000; i++) {
    const id = i % 3 === 0 ? 's0' : i % 3 === 1 ? 's1' : ids[2 + Math.floor(r() * (ids.length - 2))];
    lines.get(id)!.push(JSON.stringify(event(id)));
  }
  lines.get('s2')!.push('{"seq": torn line belt splitter');
  for (const [id, ls] of lines) {
    const text = ls.join('\n') + '\n';
    if (Number(id.slice(1)) % 4 === 3) fs.writeFileSync(path.join(dir, `${id}.jsonl.gz`), zlib.gzipSync(text));
    else fs.writeFileSync(path.join(dir, `${id}.jsonl`), text);
  }
  return { r, ids, event, pick, sentence };
}

function queries(r: () => number, ids: string[], pick: () => string) {
  const out: { q: string; sessionIds?: Set<string>; since?: number; until?: number; limit: number }[] = [];
  const fixed = ['belt splitter', '"null reference"', 'w5111 deploy', 'café', 'straße', 'σοφια', 'istanbul', 'i̇stanbul', '日本語', 'emoji🙂', 'x', 'ab y', 'back\\slash', '"quoted"', 'notes', 'command', 'zzzz none', 'tick()', 'releas', 'ss', '2026-01-01'];
  for (const q of fixed) for (const limit of [5, 30, 500]) out.push({ q, limit });
  for (let i = 0; i < 80; i++) {
    const n = 1 + Math.floor(r() * 4);
    const q = Array.from({ length: n }, () => pick().replace(/\s/g, '')).join(' ');
    const day = Date.parse('2026-09-01T00:00:00Z') + Math.floor(r() * 40) * 86_400_000;
    out.push({
      q,
      limit: [1, 5, 30, 100][Math.floor(r() * 4)],
      sessionIds: r() < 0.3 ? new Set(ids.filter(() => r() < 0.3)) : undefined,
      since: r() < 0.3 ? day : undefined,
      until: r() < 0.3 ? day + Math.floor(r() * 10) * 86_400_000 : undefined,
    });
  }
  return out;
}

function same(dir: string, index: TranscriptIndex, qs: ReturnType<typeof queries>, label: string) {
  let matched = 0;
  for (const q of qs) {
    const want = plainScan(dir, q);
    const got = index.search({ words: terms(q.q), sessionIds: q.sessionIds && [...q.sessionIds], since: q.since ?? -Infinity, until: q.until ?? Infinity, limit: q.limit });
    assert.deepEqual(got.hits, want, `${label}: ${JSON.stringify({ ...q, sessionIds: q.sessionIds && [...q.sessionIds] })}`);
    if (want.length) matched++;
  }
  return matched;
}

test('w5111: the index answers every query as the plain scan did, before and after appends, compression and rewrites', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-searchindex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { r, ids, event, pick } = corpus(dir, 5111);
  assert.ok(fs.statSync(path.join(dir, 's0.jsonl')).size > 4 * (16 << 10), 'a transcript of several chunks');
  const qs = queries(r, ids, pick);
  const index = new TranscriptIndex(dir, 16 << 10);
  const matched = same(dir, index, qs, 'fresh');
  assert.ok(matched > qs.length / 3, `most queries match something (${matched} of ${qs.length})`);
  assert.ok(index.stats().chunks > ids.length, 'the big transcripts are cut into chunks');

  // Appended to: a few lines, then a partial line (an append in progress), then the rest of it.
  const add = (id: string, n: number) => fs.appendFileSync(path.join(dir, `${id}.jsonl`), Array.from({ length: n }, () => JSON.stringify(event(id)) + '\n').join(''));
  add('s0', 3);
  add('s4', 400);
  const half = JSON.stringify(event('s1'));
  fs.appendFileSync(path.join(dir, 's1.jsonl'), half.slice(0, 20));
  same(dir, index, qs, 'appended, one line half written');
  fs.appendFileSync(path.join(dir, 's1.jsonl'), half.slice(20) + '\n');
  add('s1', 2);
  same(dir, index, qs, 'the half line finished');

  // Compressed by the data guard, then unpacked again for a resumed session and appended to.
  const plain = path.join(dir, 's4.jsonl');
  fs.writeFileSync(`${plain}.gz`, zlib.gzipSync(fs.readFileSync(plain)));
  fs.rmSync(plain);
  same(dir, index, qs, 'compressed');
  fs.writeFileSync(plain, zlib.gunzipSync(fs.readFileSync(`${plain}.gz`)));
  fs.rmSync(`${plain}.gz`);
  add('s4', 5);
  same(dir, index, qs, 'unpacked and appended');

  // Rewritten whole by a rename (Store.amend): a line changed in the middle, and the same size with other words.
  const f5 = path.join(dir, 's5.jsonl');
  const ls = fs.readFileSync(f5, 'utf8').split('\n');
  ls[1] = JSON.stringify({ ...JSON.parse(ls[1]), kind: 'assistant', text: 'amended: the reactor shield answer' });
  fs.writeFileSync(`${f5}.tmp`, ls.join('\n'));
  fs.renameSync(`${f5}.tmp`, f5);
  same(dir, index, [...qs, { q: 'amended reactor', limit: 30 }], 'rewritten');
  const f6 = path.join(dir, 's6.jsonl');
  const six = fs.readFileSync(f6, 'utf8');
  const swapped = six.replace(/belt/g, 'tleb');
  fs.writeFileSync(f6, swapped);
  fs.utimesSync(f6, new Date(), new Date(Date.now() + 5000));
  same(dir, index, [...qs, { q: 'tleb', limit: 500 }], 'rewritten in place, same size');

  // A transcript deleted, and a new one.
  fs.rmSync(path.join(dir, 's7.jsonl.gz'));
  add('s99', 50);
  same(dir, index, qs, 'one deleted, one new');
});

test('w5111: a search reads only the chunks that can match, and stops at the newest `limit`', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-searchindex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { ids } = corpus(dir, 7);
  const index = new TranscriptIndex(dir, 16 << 10);
  const total = index.search({ words: terms('belt'), since: -Infinity, until: Infinity, limit: 500 });
  const few = index.search({ words: terms('belt'), since: -Infinity, until: Infinity, limit: 5 });
  assert.equal(few.hits.length, 5);
  assert.ok(few.chunksRead < total.chunksRead / 3, `limit 5 read ${few.chunksRead} chunk(s), limit 500 read ${total.chunksRead}`);
  const none = index.search({ words: terms('qqqzzz'), since: -Infinity, until: Infinity, limit: 5 });
  assert.equal(none.hits.length, 0);
  assert.ok(none.chunksRead <= 2, `a word no chunk holds reads (almost) nothing: ${none.chunksRead} chunk(s)`);
  const one = index.search({ words: terms('belt'), sessionIds: [ids[3]], since: -Infinity, until: Infinity, limit: 500 });
  assert.ok(one.hits.every((h) => h.sessionId === ids[3]) && one.scanned === 1);
  const window = index.search({ words: terms('belt'), since: Date.parse('2026-09-20T00:00:00Z'), until: Date.parse('2026-09-21T00:00:00Z'), limit: 500 });
  assert.ok(window.chunksRead < total.chunksRead, 'a time window skips the chunks outside it');
});

test('w5111: searchText keeps the old line test', () => {
  assert.deepEqual(prefilterParts(['null reference', 'back\\slash', 'tick()']), ['null', 'reference', 'tick()']);
  const line = JSON.stringify({ seq: 1, t: '2026-09-20T10:00:00Z', kind: 'assistant', text: 'The BeltSystem has a null\nreference' });
  assert.ok(matchLine(line, ['null reference'], ['null', 'reference'], -Infinity, Infinity));
  assert.equal(matchLine(line, ['belt'], ['belt'], Date.parse('2026-09-21'), Infinity), undefined);
});

test('w5111: searchTranscripts answers through the index thread with the plain scan’s hits, masked and named', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-searchindex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  corpus(dir, 11);
  const sessions = new Map<string, SessionInfo>([['s0', { id: 's0', kind: 'worker', title: 'Zero', status: 'idle', permissionMode: 'default', createdAt: '', lastActivityAt: '', turns: 0, costUsd: 0, pendingPermissions: [], sandboxId: 'sb0' }]]);
  const r = await searchTranscripts(dir, sessions, { q: 'belt splitter', limit: 30 });
  const want = plainScan(dir, { q: 'belt splitter', limit: 30 });
  assert.deepEqual(
    r.hits.map((h) => [h.sessionId, h.seq, h.t, h.snippet]),
    want.map((h) => [h.sessionId, h.seq, h.t, h.snippet]),
  );
  const zero = r.hits.find((h) => h.sessionId === 's0');
  assert.ok(zero && zero.title === 'Zero' && zero.sandboxId === 'sb0');
});
