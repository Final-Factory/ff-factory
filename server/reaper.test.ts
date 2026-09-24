import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAutomationBrowser, pickReaps, tempProfiles, type Proc } from './reaper.ts';

// Shapes taken from the processes that leaked on the host (2026-09-24), with neutral paths.
const TMP = 'C:\\Users\\dev\\AppData\\Local\\Temp';
const PW = 'C:\\Users\\dev\\AppData\\Local\\ms-playwright';
const EDGE = '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"';
const NOW = Date.parse('2026-09-24T14:00:00Z');
const at = (hoursAgo: number) => NOW - hoursAgo * 3_600_000;
const p = (pid: number, ppid: number, name: string, cmd: string, hoursAgo: number): Proc => ({ pid, ppid, name, cmd, created: at(hoursAgo) });

const PROCS: Proc[] = [
  // An orphaned headless Edge (its script is gone) with a temp profile, and two of its helpers.
  p(44528, 40280, 'msedge.exe', `${EDGE} --headless=new --remote-debugging-port=9900 --user-data-dir="${TMP}\\edge-icon-VgmxxT" --no-first-run`, 17),
  p(29896, 44528, 'msedge.exe', `${EDGE} --type=crashpad-handler --user-data-dir=${TMP}\\edge-icon-VgmxxT /prefetch:4`, 17),
  p(43512, 44528, 'msedge.exe', `${EDGE} --type=renderer --user-data-dir="${TMP}\\edge-icon-VgmxxT"`, 17),
  // A hung Playwright WebKit (no profile on its command line) and the node script driving it, under shells.
  p(64672, 59388, 'bash.exe', '"C:\\Program Files\\Git\\usr\\bin\\bash.exe" -c "node domwk.mjs"', 13),
  p(38524, 64672, 'node.exe', 'C:\\nvm4w\\nodejs\\node.exe domwk.mjs', 13),
  p(76348, 38524, 'Playwright.exe', `${PW}\\webkit-2359\\Playwright.exe --inspector-pipe --disable-accelerated-compositing --headless --no-startup-window`, 13),
  p(45524, 76348, 'WebKitWebProcess.exe', `"${PW}\\webkit-2359\\WebKitWebProcess.exe" -type 0 -processIdentifier 6`, 13),
  // A fresh Playwright test run, its driver alive: left alone.
  p(90001, 90000, 'node.exe', 'node node_modules/@playwright/test/cli.js test', 0.1),
  p(90002, 90001, 'chrome.exe', `${PW}\\chromium-1180\\chrome-win\\chrome.exe --headless --user-data-dir=${TMP}\\playwright_chromiumdev_profile-abc`, 0.1),
  // The user's own browser (no temp profile, not headless): never.
  p(12000, 11000, 'msedge.exe', `${EDGE} --profile-directory=Default`, 40),
  // This server and its agent: never.
  p(5000, 4000, 'node.exe', 'node server/index.ts', 40),
  p(5100, 5000, 'claude.exe', 'C:\\app\\node_modules\\claude.exe --output-format stream-json', 40),
  // A just-orphaned headless browser: within the grace period.
  p(70000, 69999, 'msedge.exe', `${EDGE} --headless=new --user-data-dir="${TMP}\\edge-shot-Qx12ab"`, 0.05),
];
PROCS.push(p(40280 + 1, 1, 'explorer.exe', 'explorer.exe', 100)); // unrelated

test('reaper: which processes count as automation browsers', () => {
  const by = (pid: number) => PROCS.find((x) => x.pid === pid)!;
  assert.ok(isAutomationBrowser(by(44528), TMP, PW));
  assert.ok(isAutomationBrowser(by(76348), TMP, PW), 'Playwright WebKit carries no profile on its command line');
  assert.ok(!isAutomationBrowser(by(12000), TMP, PW), "the user's own browser");
  assert.ok(!isAutomationBrowser(by(38524), TMP, PW), 'node is not a browser');
  assert.deepEqual(tempProfiles(by(44528).cmd, TMP), [`${TMP}\\edge-icon-VgmxxT`]);
  assert.deepEqual(tempProfiles(by(29896).cmd, TMP), [`${TMP}\\edge-icon-VgmxxT`]);
  assert.deepEqual(tempProfiles(`${EDGE} --user-data-dir=D:\\profiles\\x --headless`, TMP), [], 'a profile outside the temp folder is not ours');
});

test('reaper: stale and orphaned automation browsers go (with a stale driver); nothing else', () => {
  const t = pickReaps(PROCS, { tmp: TMP, playwrightDir: PW, now: NOW, maxAgeMs: 3 * 3_600_000, selfPid: 5000 });
  const byPid = new Map(t.map((x) => [x.pid, x]));
  assert.deepEqual([...byPid.keys()].sort((a, b) => a - b), [38524, 44528]);
  // The orphaned Edge tree, with its profile to delete.
  assert.match(byPid.get(44528)!.why, /headless msedge\.exe running for 17\.0 h/);
  assert.deepEqual(byPid.get(44528)!.profiles, [`${TMP}\\edge-icon-VgmxxT`]);
  // The hung WebKit is reaped through its driver (killing the node tree takes the browser along).
  assert.match(byPid.get(38524)!.why, /Playwright\.exe running for 13\.0 h, driven by `C:\\nvm4w\\nodejs\\node\.exe domwk\.mjs`/);
  // With a lower age limit the fresh test browser is still safe (its driver lives), the young orphan too.
  const soon = pickReaps(PROCS, { tmp: TMP, playwrightDir: PW, now: NOW, maxAgeMs: 12 * 60_000, selfPid: 5000 });
  assert.ok(!soon.some((x) => [90001, 90002, 70000, 12000, 5000, 5100].includes(x.pid)));
  // Past the grace period the orphan goes even though it is young.
  const later = pickReaps(PROCS, { tmp: TMP, playwrightDir: PW, now: NOW + 15 * 60_000, maxAgeMs: 3 * 3_600_000, selfPid: 5000 });
  assert.match(later.find((x) => x.pid === 70000)?.why ?? '', /whose starter is gone/);
});
