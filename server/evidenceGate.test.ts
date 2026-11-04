import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type PlatformPath = typeof path.posix;
import { evidenceGated, evidencePython, evidenceVerdict, findPrEvidence, portalPrEvidence, type GitRun } from '../machine/evidenceGate.ts';
import { prMain, type PrDeps, type Ran } from '../machine/prFlow.ts';
import { ghMerge } from './blockerWatch.ts';
import { checkShell, type EvidenceResolver } from './guard.ts';

/**
 * w3088: no merge path skips the game repo's Evidence check. #3180 (w3080, the rejoin census fix) merged on green CI with its
 * section failing: the worker ran `pr_evidence.py --pr 3180` without --repo (a usage error, exit 2), and `ff-pr merge` in the
 * same command merged. Now `ff-pr merge`, the merge-on-green pilot (ghMerge) and a raw `gh pr merge` in the guard each run
 * `pr_evidence.py --repo <repo> --pr <n>` and refuse on anything but exit 0, naming the failing lines.
 *
 * The outputs below are what ff-agents 1.34.12's pr_evidence.py printed on BEAST, 2026-11-04: FAIL_3180 for #3180's body as
 * it merged (its edit history, 15:32Z: the `PAIR_RESULT` basis, `Determinism audit: PAIR_AUDIT`, no 'Not verified:' line;
 * the body itself is the plugin repo's fixture pr-3180-rejoin-ghost.md), PASS for its fixed body, USAGE for `--pr 3180`.
 */

const FAIL_3180 = `evidence-gate: FAIL (pr_evidence.py, ff-agents 1.34.12, the evidence-gate skill)
- 'A rejoin with a queued ghost no longer forks': the basis starts with MEASURED or SOURCED in capitals and a colon, then says how or where ('MEASURED: ui_layout.py check at 1280x720'), not 'PAIR_RESULT'
- no 'Not verified:' line: name what you could not check, or write 'nothing'
- 'Determinism audit' does not give the number of heartbeats compared
`;
const PASS = 'evidence-gate: PASS (pr_evidence.py, ff-agents 1.34.12, the evidence-gate skill)\n';
const UNCOVERED = 'PASS: no game code or assets changed, so no Evidence section is needed\n';
const USAGE = `usage: pr_evidence.py [-h] [--repo REPO] [--pr PR] [--comment]
                      [--body-file BODY_FILE] [--files-file FILES_FILE]
pr_evidence.py: error: give --repo and --pr, or --body-file, or --audit
`;

const SHA = 'a'.repeat(40);
const GAME = 'https://github.com/Final-Factory/FinalFactory/pull/3180';

function fake(url: string, evidence: Ran | undefined, script: string | null = 'pe.py'): PrDeps & { ran: string[]; said: string } {
  const ran: string[] = [];
  const d = {
    ran,
    said: '',
    run: (cmd: string, args: string[]): Ran => {
      const line = [cmd, ...args].join(' ');
      ran.push(line);
      if (line.startsWith('gh pr view')) return { code: 0, out: JSON.stringify({ number: Number(url.split('/').pop()), url, headRefOid: SHA, mergeable: 'MERGEABLE', state: 'OPEN', baseRefName: 'master' }), err: '' };
      if (line.startsWith('gh run list')) return { code: 0, out: JSON.stringify([{ databaseId: 1, workflowName: 'Test in editmode', status: 'completed', conclusion: 'success' }]), err: '' };
      if (cmd === 'py') return evidence ?? { code: 0, out: PASS, err: '' };
      return { code: 0, out: '', err: '' };
    },
    write: (s: string) => void (d.said += s),
    sleep: () => {},
    evidenceScript: () => script ?? undefined,
    python: 'py',
  };
  return d;
}
const merged = (d: { ran: string[] }) => d.ran.some((l) => l.startsWith('gh pr merge'));

test("w3088: ff-pr merge refuses #3180's old body on green CI, naming each failing line", () => {
  const d = fake(GAME, { code: 1, out: FAIL_3180, err: '' });
  assert.equal(prMain(['merge', '--pr', '3180'], d), 1);
  assert.ok(d.ran.includes('py pe.py --repo Final-Factory/FinalFactory --pr 3180'), 'run with --repo and --pr, always both');
  assert.equal(merged(d), false, 'not merged');
  assert.match(d.said, /not merged: .*pull\/3180: the Evidence check refused it \(pr_evidence\.py --repo Final-Factory\/FinalFactory --pr 3180, exit 1\)/);
  assert.match(d.said, /not 'PAIR_RESULT'/);
  assert.match(d.said, /no 'Not verified:' line/);
  assert.match(d.said, /'Determinism audit' does not give the number of heartbeats compared/);
  assert.doesNotMatch(d.said, /evidence-gate: FAIL/, 'the reasons, not the header');
});

test('w3088: ff-pr merge merges a passing body, and a PR the script does not cover', () => {
  for (const out of [PASS, UNCOVERED]) {
    const d = fake(GAME, { code: 0, out, err: '' });
    assert.equal(prMain(['merge', '--pr', '3180'], d), 0, out);
    assert.ok(merged(d), out);
    assert.ok(d.ran.findIndex((l) => l.startsWith('py ')) < d.ran.findIndex((l) => l.startsWith('gh pr merge')), 'checked before the merge');
    assert.match(d.said, /Evidence: .*PASS/);
  }
});

test('w3088: a usage error, a gh failure, no python or no script is a refusal', () => {
  const usage = fake(GAME, { code: 2, out: '', err: USAGE });
  assert.equal(prMain(['merge', '--pr', '3180'], usage), 1);
  assert.equal(merged(usage), false);
  assert.match(usage.said, /usage error, exit 2/);
  assert.match(usage.said, /error: give --repo and --pr/);
  const gh = fake(GAME, { code: 1, out: '', err: 'pr_evidence: gh pr view 3180 failed: HTTP 502' });
  assert.equal(prMain(['merge', '--pr', '3180'], gh), 1);
  assert.match(gh.said, /HTTP 502/);
  const nopy = fake(GAME, { code: 127, out: '', err: 'spawnSync py ENOENT' });
  assert.equal(prMain(['merge', '--pr', '3180'], nopy), 1);
  assert.match(nopy.said, /could not run.*ENOENT/s);
  const none = fake(GAME, undefined, null);
  assert.equal(prMain(['merge', '--pr', '3180'], none), 1);
  assert.equal(merged(none), false);
  assert.match(none.said, /no pr_evidence\.py found/);
});

test('w3088: other repositories merge with no Evidence check', () => {
  const d = fake('https://github.com/Final-Factory/ff-factory/pull/7', { code: 1, out: FAIL_3180, err: '' });
  assert.equal(prMain(['merge', '--pr', '7'], d), 0);
  assert.ok(merged(d));
  assert.equal(d.ran.some((l) => l.startsWith('py ')), false);
  assert.equal(evidenceGated('final-factory/FINALFACTORY'), true);
  assert.equal(evidenceGated('Final-Factory/ffu'), true, 'ffu since w3098');
  assert.equal(evidenceGated('Final-Factory/final-factory-agents'), false);
});

/**
 * w3098: what ff-agents 1.34.15's pr_evidence.py printed on BEAST, 2026-11-04, for ffu #222 (R.S1, the dark-mode sky made by
 * `ffu-bake darksky`) with its 'Reference capture:' and 'Art language:' lines taken out (the plugin repo's fixture
 * ffu-222-dark-sky.md and .files; its body as merged passes).
 */
const FAIL_FFU_222 = `evidence-gate: FAIL (pr_evidence.py, ff-agents 1.34.15, the evidence-gate skill)
- art changed (crates/ffu-bake/src/darksky.rs, crates/ffu-bake/src/lib.rs, crates/ffu-bake/src/main.rs) and no 'Reference capture:' line: name the still or clip of the reference as a player sees it in the built game (its lighting, bloom, camera and placement), not its texture or model file or the source pack (checklists/visual.md 5o; Ben, w2895: "it doenst look right")
- no 'Art language:' line: say the two solid main colours and the one bright, bloomy HDR accent, and how they read on screen beside the game's own art (checklists/visual.md 5c; Ben, w2895: "they need to match my art style")
`;
const FFU = 'https://github.com/Final-Factory/ffu/pull/222';

test('w3098: ff-pr merge refuses an ffu art PR without its Reference capture and Art language lines, and merges it with them', () => {
  const bare = fake(FFU, { code: 1, out: FAIL_FFU_222, err: '' });
  assert.equal(prMain(['merge', '--pr', '222'], bare), 1);
  assert.ok(bare.ran.includes('py pe.py --repo Final-Factory/ffu --pr 222'));
  assert.equal(merged(bare), false);
  assert.match(bare.said, /not merged: .*ffu\/pull\/222/);
  assert.match(bare.said, /no 'Reference capture:' line/);
  assert.match(bare.said, /no 'Art language:' line/);
  const good = fake(FFU, { code: 0, out: PASS, err: '' });
  assert.equal(prMain(['merge', '--pr', '222'], good), 0);
  assert.ok(merged(good));
  const docs = fake('https://github.com/Final-Factory/ffu/pull/208', { code: 0, out: UNCOVERED, err: '' });
  assert.equal(prMain(['merge', '--pr', '208'], docs), 0, 'a docs-only ffu PR passes the script and merges');
  assert.ok(merged(docs));
});

test('w3088: evidenceVerdict passes exit 0 only; a FAIL names its reasons without the notes', () => {
  assert.deepEqual(evidenceVerdict(0, PASS, ''), { ok: true, lines: [PASS.trim()] });
  const v = evidenceVerdict(1, `${FAIL_3180}- note: could not ask GitHub for the released ff-agents version\n`, '');
  assert.equal(v.ok, false);
  assert.equal(v.lines.length, 3);
  assert.ok(v.lines.every((l) => l.startsWith('- ') && !l.startsWith('- note:')));
  assert.deepEqual(evidenceVerdict(2, '', USAGE).lines.slice(-1), ['pr_evidence.py: error: give --repo and --pr, or --body-file, or --audit']);
  assert.equal(evidenceVerdict(1, PASS, '').ok, false, 'the exit decides, not the text');
});

test('w3088: the merge-on-green pilot refuses what the Evidence check fails, and merges what it passes', async () => {
  const runner = (evidence: { code: number; stdout: string; stderr: string }, calls: string[][]) => async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return (cmd === 'gh' ? { code: 0, stdout: '', stderr: '' } : evidence) as never;
  };
  const failed: string[][] = [];
  await assert.rejects(
    ghMerge('Final-Factory/FinalFactory#3180', SHA, runner({ code: 1, stdout: FAIL_3180, stderr: '' }, failed), () => 'pe.py'),
    (e: Error) => /not merged: the Evidence check refused it/.test(e.message) && /PAIR_RESULT/.test(e.message) && /no 'Not verified:' line/.test(e.message),
  );
  assert.deepEqual(failed, [[evidencePython(), 'pe.py', '--repo', 'Final-Factory/FinalFactory', '--pr', '3180']], 'never merged');
  const usage: string[][] = [];
  await assert.rejects(ghMerge('Final-Factory/FinalFactory#3180', SHA, runner({ code: 2, stdout: '', stderr: USAGE }, usage), () => 'pe.py'), /usage error, exit 2/);
  assert.equal(usage.some((c) => c[2] === 'merge'), false);
  const none: string[][] = [];
  await assert.rejects(ghMerge('Final-Factory/FinalFactory#3180', SHA, runner({ code: 0, stdout: PASS, stderr: '' }, none), () => undefined), /no pr_evidence\.py found/);
  assert.deepEqual(none, []);
  const passed: string[][] = [];
  await ghMerge('Final-Factory/FinalFactory#3180', SHA, runner({ code: 0, stdout: PASS, stderr: '' }, passed), () => 'pe.py');
  assert.deepEqual(passed.at(-1), ['gh', 'pr', 'merge', '3180', '-R', 'Final-Factory/FinalFactory', '--merge', '--match-head-commit', SHA]);
  // w3098: ffu is checked too; another repository is not.
  const ffu: string[][] = [];
  await assert.rejects(ghMerge('Final-Factory/ffu#222', SHA, runner({ code: 1, stdout: FAIL_FFU_222, stderr: '' }, ffu), () => 'pe.py'), /no 'Art language:' line/);
  assert.deepEqual(ffu, [[evidencePython(), 'pe.py', '--repo', 'Final-Factory/ffu', '--pr', '222']], 'ffu: never merged');
  const ffuPass: string[][] = [];
  await ghMerge('Final-Factory/ffu#222', SHA, runner({ code: 0, stdout: PASS, stderr: '' }, ffuPass), () => 'pe.py');
  assert.deepEqual(ffuPass.at(-1), ['gh', 'pr', 'merge', '222', '-R', 'Final-Factory/ffu', '--merge', '--match-head-commit', SHA]);
  const other: string[][] = [];
  await ghMerge('Final-Factory/final-factory-agents#572', SHA, runner({ code: 1, stdout: FAIL_3180, stderr: '' }, other), () => undefined);
  assert.equal(other.length, 1, 'final-factory-agents: no Evidence check');
});

test('w3088: a raw gh pr merge (or the API merge) of a game repo PR is refused when its Evidence check refuses it', () => {
  const remotes = (dir: string) => (dir.replace(/\\/g, '/').toLowerCase() === 'c:/ffsb/sb1' ? new Map([['origin', 'https://github.com/Final-Factory/FinalFactory.git']]) : new Map([['origin', 'https://github.com/Final-Factory/ff-factory.git']]));
  const asked: (string | undefined)[] = [];
  const evidence: EvidenceResolver = (pr) => (asked.push(pr), pr === '3180' ? 'Not merged: the Evidence check refused it (pr_evidence.py --repo Final-Factory/FinalFactory --pr 3180, exit 1): - no \'Not verified:\' line' : undefined);
  const ctx = { cwd: 'C:/ffsb/sb1', gameRepos: ['https://github.com/Final-Factory/FinalFactory.git'], remotes, prBase: () => 'master', evidence };
  assert.match(checkShell('gh pr merge 3180 --merge', ctx) ?? '', /Evidence check refused it.*no 'Not verified:' line/);
  assert.match(checkShell('gh api -X PUT repos/Final-Factory/FinalFactory/pulls/3180/merge', ctx) ?? '', /Evidence check refused it/);
  assert.equal(checkShell('gh pr merge 3181 --merge', ctx), undefined, 'a passing PR merges');
  assert.equal(checkShell('gh pr view 3180', ctx), undefined, 'only a merge is checked');
  assert.equal(checkShell('cd C:/tmp/tools && gh pr merge 3180 --merge', ctx), undefined, 'another repo is not checked');
  assert.deepEqual(asked, ['3180', '3180', '3181']);
  // w3098: an ffu clone's merge, by its remote or by -R, is checked too (ffu-build-test merges with a raw gh pr merge).
  const ffuRemotes = (dir: string) => new Map([['origin', dir.includes('ffu') ? 'https://github.com/Final-Factory/ffu.git' : 'https://github.com/Final-Factory/ff-factory.git']]);
  const ffuAsked: (string | undefined)[] = [];
  const ffuEvidence: EvidenceResolver = (pr, repo) => (ffuAsked.push(`${repo ?? ''}#${pr}`), pr === '222' ? 'Not merged: the Evidence check refused it (pr_evidence.py --repo Final-Factory/ffu --pr 222, exit 1)' : undefined);
  const ffuCtx = { cwd: 'C:/tmp/ffu', gameRepos: ['https://github.com/Final-Factory/FinalFactory.git'], remotes: ffuRemotes, prBase: () => 'main', evidence: ffuEvidence };
  assert.match(checkShell('gh pr merge 222 --merge --match-head-commit abc', ffuCtx) ?? '', /Evidence check refused it/);
  assert.match(checkShell('cd C:/tmp/tools && gh pr merge 222 -R Final-Factory/ffu --merge', ffuCtx) ?? '', /Evidence check refused it/);
  assert.match(checkShell('gh api -X PUT repos/Final-Factory/ffu/pulls/222/merge', ffuCtx) ?? '', /Evidence check refused it/);
  assert.equal(checkShell('cd C:/tmp/tools && gh pr merge 222 --merge', ffuCtx), undefined, 'ff-factory is not checked');
  assert.deepEqual(ffuAsked, ['#222', 'Final-Factory/ffu#222', 'Final-Factory/ffu#222']);
});

test('w3088: findPrEvidence picks the newest copy by plugin.json version (sort -V, not by name)', () => {
  const home = '/h';
  const cache = path.join(home, '.claude', 'plugins', 'cache', 'final-factory-agents', 'ff-agents');
  const versions: Record<string, string> = { [path.join(cache, '1.34.9')]: '1.34.9', [path.join(cache, '1.34.12')]: '1.34.12', '/ffw/tools/final-factory-agents/plugins/ff-agents': '1.34.10' };
  const script = (p: string) => path.join(p, 'skills', 'evidence-gate', 'pr_evidence.py');
  const deps = {
    env: { FF_WORKER_ROOT: '/ffw' },
    home,
    list: (d: string) => (d === cache ? ['1.34.9', '1.34.12'] : []),
    exists: (p: string) => Object.keys(versions).some((v) => script(v) === p),
    read: (p: string) => JSON.stringify({ version: versions[path.dirname(path.dirname(p))] }),
  };
  assert.equal(findPrEvidence(deps), script(path.join(cache, '1.34.12')));
  assert.equal(findPrEvidence({ ...deps, list: () => [] }), script('/ffw/tools/final-factory-agents/plugins/ff-agents'));
  assert.equal(findPrEvidence({ ...deps, list: () => [], env: {} }), undefined);
  assert.equal(findPrEvidence({ ...deps, env: { FF_PR_EVIDENCE: '/x/pe.py' }, exists: (p) => p === '/x/pe.py' }), '/x/pe.py');
});

/**
 * w3110: the pilot's merge runs in the portal's process, on the portal VM, whichever machine the worker is on. The portal has
 * no plugin cache, no FF_SKILLS and no FF_WORKER_ROOT, so findLocalPrEvidence found nothing there and FinalFactory #3186,
 * #3187 and ffu #237 (2026-11-04, workers on BEAST) were refused on green with "no pr_evidence.py found". The portal now
 * keeps its own checkout of final-factory-agents (portalPrEvidence) and runs the script from it.
 */
test('w3110: the merge-on-green pilot on the portal runs pr_evidence.py from its own checkout: refuses a FAIL, merges a PASS', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3110-data-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'w3110-home-'));
  const co = path.join(dataDir, 'tools', 'final-factory-agents');
  const script = path.join(co, 'plugins', 'ff-agents', 'skills', 'evidence-gate', 'pr_evidence.py');
  // The bug: the portal's own environment finds no script.
  assert.equal(findPrEvidence({ env: {}, home }), undefined);
  const gits: string[][] = [];
  let cloneWorks = true;
  const git: GitRun = async (cmd, args) => {
    gits.push(args.filter((a) => !a.startsWith('credential.') && a !== '-c'));
    if (args.includes('clone') && cloneWorks) {
      fs.mkdirSync(path.join(co, '.git'), { recursive: true });
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(script, '# pr_evidence.py');
      fs.mkdirSync(path.join(co, 'plugins', 'ff-agents', '.claude-plugin'));
      fs.writeFileSync(path.join(co, 'plugins', 'ff-agents', '.claude-plugin', 'plugin.json'), '{"version":"1.34.16"}');
    }
    return { code: args.includes('clone') && !cloneWorks ? 128 : 0, stdout: '', stderr: '' };
  };
  const portal = () => portalPrEvidence({ dataDir, run: git, env: {}, home });
  const runner = (evidence: { code: number; stdout: string; stderr: string }, calls: string[][]) => async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return (cmd === 'gh' ? { code: 0, stdout: '', stderr: '' } : evidence) as never;
  };

  // No checkout and the clone fails: still refused, never merged without the check.
  cloneWorks = false;
  const none: string[][] = [];
  await assert.rejects(ghMerge('Final-Factory/FinalFactory#3186', SHA, runner({ code: 0, stdout: PASS, stderr: '' }, none), portal), /no pr_evidence\.py found/);
  assert.deepEqual(none, []);

  cloneWorks = true;
  const failed: string[][] = [];
  await assert.rejects(ghMerge('Final-Factory/ffu#237', SHA, runner({ code: 1, stdout: FAIL_FFU_222, stderr: '' }, failed), portal), /no 'Art language:' line/);
  assert.deepEqual(failed, [[evidencePython(), script, '--repo', 'Final-Factory/ffu', '--pr', '237']], 'cloned, ran, never merged');
  assert.ok(gits.some((a) => a[0] === 'clone' && a.includes('https://github.com/Final-Factory/final-factory-agents.git') && a.at(-1) === co));

  // The next merge brings the checkout up to date (a stale copy FAILs every PR, w733), then merges on a PASS.
  const passed: string[][] = [];
  await ghMerge('Final-Factory/FinalFactory#3187', SHA, runner({ code: 0, stdout: PASS, stderr: '' }, passed), portal);
  assert.deepEqual(passed[0], [evidencePython(), script, '--repo', 'Final-Factory/FinalFactory', '--pr', '3187']);
  assert.deepEqual(passed.at(-1), ['gh', 'pr', 'merge', '3187', '-R', 'Final-Factory/FinalFactory', '--merge', '--match-head-commit', SHA]);
  assert.deepEqual(gits.slice(-2).map((a) => a.slice(2, 3)[0]), ['fetch', 'reset']);
});

test("w3110: a worker's own lookup (ff-pr merge, the guard) finds FF_SKILLS's script on BEAST (Windows) and on a Mac", () => {
  const cases: { P: PlatformPath; home: string; skills: string }[] = [
    { P: path.win32, home: 'C:\\Users\\rydin', skills: 'C:\\Users\\rydin\\.claude\\plugins\\cache\\final-factory-agents\\ff-agents\\1.34.16\\skills' },
    { P: path.win32, home: 'C:\\Users\\rydin', skills: 'F:/ffw/tools/final-factory-agents/plugins/ff-agents/skills' },
    { P: path.posix, home: '/Users/ben', skills: '/Users/ben/.claude/plugins/cache/final-factory-agents/ff-agents/1.34.16/skills' },
  ];
  for (const c of cases) {
    const want = c.P.join(c.skills, 'evidence-gate', 'pr_evidence.py');
    const found = findPrEvidence({ env: { FF_SKILLS: c.skills }, home: c.home, pathApi: c.P, list: () => [], exists: (p) => p === want, read: () => '{"version":"1.34.16"}' });
    assert.equal(found, want, c.skills);
  }
});
