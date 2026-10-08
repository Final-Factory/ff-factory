import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PathHealthMonitor, describeProblem, filePathHealth, parsePathHealth, SILENT_AFTER_MS } from './pathHealth.ts';
import type { PathHealth } from '../shared/types.ts';

// The status files fff-vm watch (deploy/vm/host/pathwatch.sh) wrote in deploy/vm/test/fff-vm-path.test.sh, with their times
// and host name replaced: that test fails when the script's output stops matching them, and these tests read them.
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'vm', 'test', 'path-fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');
const AT = Date.parse('2026-10-07T18:30:00Z');

test('the watchdog\'s healthy file: ok, no problem, fourteen layers', () => {
  const h = parsePathHealth(read('status-file.healthy.json'), AT + 60_000)!;
  assert.equal(h.ok, true);
  assert.deepEqual(h.problems, []);
  assert.equal(h.dns, 'fff.example-tailnet.ts.net');
  assert.equal(h.silentMinutes, undefined);
});

test('the watchdog\'s file for a tailnet policy that drops Funnel: the layer, the evidence, who must act', () => {
  const h = parsePathHealth(read('status-file.policy.json'), AT + 60_000)!;
  assert.equal(h.ok, false);
  assert.deepEqual(h.problems.map((p) => p.id), ['7', '9']);
  const p = h.problems[0];
  assert.equal(p.name, 'tailnet policy');
  assert.match(p.line, /^the tailnet policy drops Funnel traffic: a tailnet admin must grant tag:ingress \(or \*\) → tag:fff-portal\. 3 line\(s\) in 15 min, last: .*Drop: TCP\{100\.100\.3\.13:50112 > 100\.64\.0\.5:59917\} 60 no rules matched$/);
  assert.equal(p.who, 'tailnet admin: grant tag:ingress → tag:fff-portal in the tailnet policy');
  assert.match(describeProblem(p), /^tailnet policy \(layer 7\) has failed since 2026-10-07 18:30Z: the tailnet policy drops Funnel traffic.* Who must act: tailnet admin: grant tag:ingress → tag:fff-portal in the tailnet policy\.$/);
});

test('a file that is not the watchdog\'s, or half written, shows nothing', () => {
  for (const text of ['', '{', 'null', '[]', '{"schema":2,"updatedAt":"2026-10-07T18:30:00Z","problems":[]}', '{"schema":1,"problems":[]}', '{"schema":1,"updatedAt":"x"}']) {
    assert.equal(parsePathHealth(text, AT), undefined, text);
  }
});

test('a silent watchdog: its old problems are not shown as current, and it says so', () => {
  const h = parsePathHealth(read('status-file.policy.json'), AT + SILENT_AFTER_MS + 5 * 60_000)!;
  assert.equal(h.silentMinutes, 35);
  assert.equal(h.ok, false);
  assert.deepEqual(h.problems, []);
});

test('unknown verdicts and long or odd text are made safe', () => {
  const h = parsePathHealth(
    JSON.stringify({ schema: 1, updatedAt: '2026-10-07T18:30:00Z', host: 'ffbox', dns: 'x', ok: false, problems: [{ id: '3', name: 'node identity', verdict: 'boom', since: 's', checkedAt: 'c', line: 'a\n\nb  ' + 'x'.repeat(2000), who: 7, repair: null }, { name: 'no id' }, 5], warnings: [], layers: [] }),
    AT,
  )!;
  assert.equal(h.problems.length, 1);
  assert.equal(h.problems[0].verdict, 'none');
  assert.equal(h.problems[0].line.length, 700);
  assert.ok(!h.problems[0].line.includes('\n'));
  assert.equal(h.problems[0].who, '');
});

function monitor(files: { text?: string }, clock = { t: AT + 60_000 }) {
  const reports: [string, string][] = [];
  const changes: (PathHealth | undefined)[] = [];
  const m = new PathHealthMonitor({
    read: () => files.text,
    now: () => clock.t,
    changed: (h) => changes.push(h),
    report: (t, b) => reports.push([t, b]),
    log: () => undefined,
  });
  return { m, reports, changes, clock };
}

test('the monitor: no file, nothing to show; the first read notes a standing problem without announcing it', () => {
  const f: { text?: string } = {};
  const { m, reports, changes } = monitor(f);
  m.tick();
  assert.equal(m.status, undefined);
  assert.deepEqual(changes, []);
  f.text = read('status-file.policy.json');
  const again = monitor(f);
  again.m.tick();
  assert.equal(again.changes.length, 1);
  assert.equal(again.changes[0]?.problems.length, 2);
  assert.deepEqual(again.reports, [], 'a restart of the portal does not announce a standing problem again');
  assert.deepEqual(reports, []);
});

test('the monitor: a new problem is reported once, again when it clears; the banner changes only when what it shows changes', () => {
  const f: { text?: string } = { text: read('status-file.healthy.json') };
  const { m, reports, changes, clock } = monitor(f);
  m.tick();
  assert.equal(changes.length, 0, 'healthy: the banner stays empty');
  f.text = read('status-file.policy.json');
  m.tick();
  m.tick();
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.problems[0].id, '7');
  assert.equal(reports.length, 2, 'layer 7 and layer 9, once each');
  assert.equal(reports[0][0], 'Portal path problem: tailnet policy');
  assert.match(reports[0][1], /Who must act: tailnet admin: grant tag:ingress/);
  clock.t += 60_000;
  m.tick();
  assert.equal(reports.length, 2, 'the same problem is not reported again');
  f.text = read('status-file.healthy.json');
  m.tick();
  assert.equal(changes.length, 2);
  assert.equal(changes[1], undefined, 'the banner clears when the check passes again');
  assert.deepEqual(reports.slice(2).map((r) => r[0]), ['Portal path problem cleared', 'Portal path problem cleared']);
});

test('the monitor: a watchdog that goes silent is reported once, and again when it is back', () => {
  const f: { text?: string } = { text: read('status-file.healthy.json') };
  const { m, reports, changes, clock } = monitor(f);
  m.tick();
  clock.t += SILENT_AFTER_MS + 120_000;
  m.tick();
  m.tick();
  assert.equal(changes.at(-1)?.silentMinutes, 33);
  assert.deepEqual(reports.map((r) => r[0]), ['The VM watchdog is silent']);
  f.text = read('status-file.healthy.json').replaceAll('2026-10-07T18:30:00Z', new Date(clock.t).toISOString().replace(/\.\d+Z$/, 'Z'));
  m.tick();
  assert.deepEqual(reports.map((r) => r[0]), ['The VM watchdog is silent', 'The VM watchdog reports again']);
  assert.equal(changes.at(-1), undefined);
});

test('system_status lines: a problem in full for the orchestrator to relay, a healthy path in one line, the silence', () => {
  const f: { text?: string } = { text: read('status-file.policy.json') };
  const { m, clock } = monitor(f);
  m.tick();
  const lines = m.statusLines();
  assert.match(lines[0], /^PROBLEM: the portal's path from the internet is broken \(fff-vm watch on ffbox, 2026-10-07T18:30:00Z\)\. Tell your person:$/);
  assert.match(lines[1], /^ {2}- tailnet policy \(layer 7\) has failed since .*Who must act: tailnet admin: grant tag:ingress → tag:fff-portal in the tailnet policy\.$/);
  assert.match(lines[2], /^ {2}- end to end \(layer 9\) has failed since/);
  f.text = read('status-file.healthy.json');
  m.tick();
  assert.deepEqual(m.statusLines(), ['Portal path (internet → Funnel → https://fff.example-tailnet.ts.net → portal): every layer passes (fff-vm watch on ffbox, 2026-10-07T18:30:00Z).']);
  clock.t += SILENT_AFTER_MS + 60_000;
  m.tick();
  assert.match(m.statusLines()[0], /^WARNING: Portal path watchdog \(fff-vm watch on ffbox\) has been silent for 32 min/);
  assert.deepEqual(monitor({}).m.statusLines(), [], 'no watchdog, no line');
});

test('the file reader: a missing file is "nothing", any other error is raised', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'ph-'));
  try {
    assert.equal(filePathHealth(path.join(dir, 'nope.json'))(), undefined);
    fs.writeFileSync(path.join(dir, 'a.json'), 'x');
    assert.equal(filePathHealth(path.join(dir, 'a.json'))(), 'x');
    assert.throws(() => filePathHealth(dir)());
    const bad = new PathHealthMonitor({ read: () => filePathHealth(dir)(), now: () => AT, changed: () => undefined, report: () => undefined, log: () => undefined });
    bad.tick(); // logs, does not throw
    assert.equal(bad.status, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
