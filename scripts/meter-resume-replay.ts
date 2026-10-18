// The context meter across processes, replayed (w1484): real Claude Code transcripts (the CLI's jsonl) through the ContextMeter,
// cut into processes where a turn begins, three ways: unbroken (one process), carried (each cut a new meter with carry(): the meter
// before w1484) and kept (each cut a new meter resumed from the last one's snapshot, through JSON: w1484). Prints carried's share
// of the list-price dollars each way, every category's share, and how the base each resume measured compares with the one before.
// A diagnostic run by hand (docs/spend.md "A conversation across processes"), not a test.
//
//   node scripts/meter-resume-replay.ts [--root <projects dir>] [--days 3] [--cut turn|gap30] [--dirs <regex of project folders>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContextMeter, addCats, type Cats } from '../shared/spend.ts';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const root = arg('--root', path.join(os.homedir(), '.claude', 'projects'));
const since = Date.now() - Number(arg('--days', '3')) * 864e5;
const cut = arg('--cut', 'turn');
const dirs = new RegExp(arg('--dirs', String.raw`sandboxes-slot\d`));
type D = Record<string, any>;
const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: D) => (b?.type === 'text' ? b.text ?? '' : '')).join('') : '');
const imagesIn = (c: unknown) => (Array.isArray(c) ? c.filter((b: D) => b?.type === 'image').length : 0);

interface Out { cats: Cats; cuts: number; compactions: number; resumedKept: number; resumedCarried: number; baseDrift: number[] }
function run(lines: D[], mode: 'unbroken' | 'carried' | 'kept'): Out {
  const usages = new Map<string, D>();
  for (const d of lines) if (d.type === 'assistant' && d.message?.id && d.message.usage) usages.set(d.message.id, d.message);
  let m = new ContextMeter();
  const o: Out = { cats: {}, cuts: 0, compactions: 0, resumedKept: 0, resumedCarried: 0, baseDrift: [] };
  const drain = () => {
    const t = m.drain();
    o.cats = addCats(o.cats, t.cats);
    if (t.compacted) o.compactions++;
    if (t.resumed?.kept) {
      o.resumedKept++;
      o.baseDrift.push(t.resumed.base - t.resumed.prevBase);
    } else if (t.resumed) o.resumedCarried++;
  };
  let lastAt = 0;
  let calls = 0;
  for (const d of lines) {
    if (d.isSidechain) continue;
    const at = Date.parse(d.timestamp ?? '') || lastAt;
    const turnStart = d.type === 'user' && d.turnPosition && typeof d.message?.content === 'string';
    if (turnStart && calls > 0) {
      drain();
      const doCut = cut === 'turn' || at - lastAt > 30 * 60_000;
      if (doCut && mode !== 'unbroken') {
        o.cuts++;
        const next = new ContextMeter();
        if (mode === 'kept') next.resume(JSON.parse(JSON.stringify(m.snapshot())));
        else next.carry();
        m = next;
      }
    }
    if (d.type === 'system' && d.subtype === 'compact_boundary') m.summary(d.compactMetadata?.postTokens ?? 0);
    else if (d.type === 'user' && typeof d.message?.content === 'string') m.addUser(d.message.content.length);
    else if (d.type === 'user' && Array.isArray(d.message?.content)) {
      for (const b of d.message.content) {
        if (b?.type === 'tool_result' && b.tool_use_id) m.addToolResult(b.tool_use_id, textOf(b.content).length, imagesIn(b.content));
        else if (b?.type === 'text' && b.text) m.addUser(b.text.length);
      }
    } else if (d.type === 'assistant' && d.message?.id) {
      const msg = usages.get(d.message.id)!;
      const u = msg.usage;
      m.call({ id: msg.id, model: msg.model, in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cr: u.cache_read_input_tokens ?? 0, cw: u.cache_creation_input_tokens ?? 0, cw5: u.cache_creation?.ephemeral_5m_input_tokens ?? 0 });
      calls++;
      for (const b of Array.isArray(d.message.content) ? d.message.content : []) if (b?.type === 'tool_use' && b.id) m.addToolUse(b.id, b.name ?? '', b.input, 0);
    }
    if (d.timestamp) lastAt = d.type === 'assistant' ? at : lastAt;
  }
  drain();
  return o;
}

const usd = (c: Cats) => Object.values(c).reduce((a, x) => a + x.usd, 0);
const tot = { unbroken: {} as Cats, carried: {} as Cats, kept: {} as Cats };
let files = 0;
let cuts = 0;
let compacted = 0;
let kept = 0;
const drift: number[] = [];
for (const dir of fs.readdirSync(root).filter((d) => dirs.test(d))) {
  for (const f of fs.readdirSync(path.join(root, dir)).filter((x) => x.endsWith('.jsonl'))) {
    const p = path.join(root, dir, f);
    if (fs.statSync(p).mtimeMs < since) continue;
    const seen = new Set<string>();
    const lines: D[] = [];
    for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!raw) continue;
      let d: D;
      try {
        d = JSON.parse(raw);
      } catch {
        continue;
      }
      if (d.uuid) {
        if (seen.has(d.uuid)) continue;
        seen.add(d.uuid);
      }
      lines.push(d);
    }
    const a = run(lines, 'unbroken');
    const b = run(lines, 'carried');
    const c = run(lines, 'kept');
    if (!c.cuts) continue;
    files++;
    cuts += c.cuts;
    if (a.compactions) compacted++;
    kept += c.resumedKept;
    drift.push(...c.baseDrift);
    tot.unbroken = addCats(tot.unbroken, a.cats);
    tot.carried = addCats(tot.carried, b.cats);
    tot.kept = addCats(tot.kept, c.cats);
  }
}
const pct = (c: Cats, k: string) => (100 * (c[k]?.usd ?? 0)) / usd(c);
console.log(`cut at: ${cut}; transcripts with a cut: ${files} (${compacted} with a compaction); cuts: ${cuts}; resumes kept: ${kept}`);
console.log(`list-price usd: unbroken ${usd(tot.unbroken).toFixed(2)} carried-mode ${usd(tot.carried).toFixed(2)} kept-mode ${usd(tot.kept).toFixed(2)}`);
console.log(`carried share: before w1484 ${pct(tot.carried, 'carried').toFixed(2)}%  with w1484 ${pct(tot.kept, 'carried').toFixed(3)}%`);
const cats = [...new Set([...Object.keys(tot.unbroken), ...Object.keys(tot.kept), ...Object.keys(tot.carried)])].sort((x, y) => (tot.unbroken[y]?.usd ?? 0) - (tot.unbroken[x]?.usd ?? 0));
console.log('category      unbroken%  before%  w1484%');
for (const k of cats) console.log(`${k.padEnd(13)} ${pct(tot.unbroken, k).toFixed(2).padStart(8)} ${pct(tot.carried, k).toFixed(2).padStart(8)} ${pct(tot.kept, k).toFixed(2).padStart(8)}`);
drift.sort((x, y) => x - y);
const q = (f: number) => drift[Math.floor(f * (drift.length - 1))] ?? 0;
console.log(`base measured again at each resume, less the base before: min ${q(0).toFixed(0)} median ${q(0.5).toFixed(0)} p95 ${q(0.95).toFixed(0)} max ${q(1).toFixed(0)} tokens`);
