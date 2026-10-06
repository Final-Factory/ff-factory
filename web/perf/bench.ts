// A performance benchmark for the web UI: the built page (web/dist) against the mock backend at a real portal's
// scale (web/mock/scale.ts), in headless Chromium, measured with the page's own timers and the DevTools protocol.
//
//   npm --prefix web run build
//   node web/perf/bench.ts                              # synthetic: 7,000 stopped agents, an 8,000-event chat
//   node web/perf/bench.ts --cpu 4 --idle 30 --memory 10  # 4x slower CPU, 30 s idle, a 10-minute memory run
//   MOCK_STATE_FILE=… MOCK_TRANSCRIPT_FILE=… MOCK_WORK_FILE=… node web/perf/bench.ts   # a real portal's data
//   node web/perf/bench.ts --json out.json --dist other/dist   # write the numbers; measure another build
//   node web/perf/bench.ts --route '#/machine/beast/sandbox/agent-mcp'  # the chat beside the sandbox holding most past agents
//
// What it reports:
//   typing   each key typed into the orchestrator's message box: `work` from the keydown to the first task after
//            it (the handler, React's render, and anything queued ahead), and p50/p95/max to the next frame (a rAF
//            then a task, so it includes waiting for the display's refresh, up to 16.7 ms at 60 Hz); React
//            commits and component renders per key; long tasks while typing. Live agent traffic runs meanwhile.
//   idle     the main thread's busy share (DevTools TaskDuration) and React commits per second, sitting on the
//            home page with live traffic and nothing typed.
//   --check  fail (exit 1) when a budget is broken: components per key, DOM size, typing p95, long tasks, layouts
//            per second at rest (with --live 0). CI runs it on the orchestrator and on the busiest sandbox.
//   memory   the JS heap after a forced GC, sampled each minute over --memory minutes of live traffic.
//   payload  the size of /api/state and the time to the first usable page.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page, type CDPSession } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const CPU = Number(opt('cpu', '1'));
const KEYS = Number(opt('keys', '200'));
const KEY_GAP = Number(opt('gap', '60'));
const IDLE_S = Number(opt('idle', '20'));
const MEMORY_MIN = Number(opt('memory', '0'));
const LIVE = opt('live', '4');
const PORT = Number(opt('port', '8799'));
const DIST = opt('dist', path.join(HERE, '..', 'dist'));
const JSON_OUT = opt('json', '');
// The page to measure on: '' (the orchestrator), or e.g. '#/machine/beast/sandbox/agent-mcp' (on a wide screen the orchestrator's
// chat beside a sandbox with thousands of past agents).
const ROUTE = opt('route', '');
// --check: exit 1 when a budget below is broken (CI runs it). Counts, not milliseconds, where possible: they do not
// depend on how fast the machine is.
const CHECK = args.includes('--check');
const BUDGET = { rendersPerKey: 30, domNodes: 8000, workP95Ms: 50, layoutsPerSecIdle: 20, longTasksTyping: 2 };

// Counts React commits and the components each one rendered, through the hook React DevTools uses (it works in a
// production build). As DevTools does, only fibers whose parent re-created its children are visited (a skipped
// subtree keeps the flags of its last render); PerformedWork (1) marks a component that ran.
const INIT = `
(() => {
  const perf = (window.__perf = { commits: 0, renders: 0, count: false, keys: [], work: [], longtasks: [] });
  const COMPONENT = new Set([0, 1, 11, 14, 15]);
  const walk = (root) => {
    let n = 0;
    const stack = [root];
    while (stack.length) {
      const f = stack.pop();
      if (COMPONENT.has(f.tag) && (f.flags & 1)) n++;
      if (f.alternate && f.child === f.alternate.child) continue;
      for (let c = f.child; c; c = c.sibling) stack.push(c);
    }
    return n;
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(r) { this.renderers.set(this.renderers.size + 1, r); return this.renderers.size; },
    onCommitFiberRoot(_id, root) { perf.commits++; if (perf.count) perf.renders += walk(root.current); },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) perf.longtasks.push(e.duration); }).observe({ type: 'longtask', buffered: true });
  addEventListener('keydown', (e) => {
    const t0 = e.timeStamp;
    const w = new MessageChannel();
    w.port1.onmessage = () => perf.work.push(performance.now() - t0);
    w.port2.postMessage(0);
    requestAnimationFrame(() => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => perf.keys.push(performance.now() - t0);
      ch.port2.postMessage(0);
    });
  }, true);
})();
`;

/** What the init script above collects in the page. */
interface Perf {
  commits: number;
  renders: number;
  count: boolean;
  keys: number[];
  work: number[];
  longtasks: number[];
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const r1 = (x: number) => Math.round(x * 10) / 10;

async function startMock() {
  const child = spawn(process.execPath, [path.join(HERE, '..', 'mock', 'server.ts')], {
    env: { MOCK_SCALE: '7000', MOCK_TRANSCRIPT_EVENTS: '8000', ...process.env, PORT: String(PORT), MOCK_NOAUTH: '1', MOCK_DIST: DIST, MOCK_LIVE: LIVE },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    child.on('exit', (c) => reject(new Error(`mock exited ${c}`)));
    child.stdout!.on('data', (d: Buffer) => d.toString().includes('http://localhost') && resolve());
  });
  return child;
}

async function metric(cdp: CDPSession, name: string) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((m) => m.name === name)?.value ?? 0;
}

async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

async function heapMB(cdp: CDPSession) {
  await cdp.send('HeapProfiler.collectGarbage');
  return (await metric(cdp, 'JSHeapUsedSize')) / 2 ** 20;
}

async function typing(page: Page, cdp: CDPSession) {
  const before = await metrics(cdp);
  const box = page.locator('.composer-input').first();
  await box.click({ timeout: 120_000 });
  await page.evaluate(() => {
    const p = (window as unknown as { __perf: Perf }).__perf;
    p.keys = [];
    p.work = [];
    p.longtasks = [];
    p.commits = 0;
    p.renders = 0;
    p.count = true;
  });
  const text = 'Start work on spec 098 and tell me what is running on the belts, then the fleet ';
  for (let i = 0; i < KEYS; i++) await page.keyboard.type(text[i % text.length], { delay: 0 }).then(() => page.waitForTimeout(KEY_GAP));
  await page.waitForTimeout(300);
  const after = await metrics(cdp);
  const perKey = (k: string) => r1(((after[k] - before[k]) * 1000) / KEYS);
  const p = await page.evaluate(() => (window as unknown as { __perf: Perf }).__perf);
  await page.evaluate(() => ((window as unknown as { __perf: Perf }).__perf.count = false));
  // Leave the box empty for the next run (the draft is kept per chat).
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  return {
    keys: p.keys.length,
    workP50: r1(pct(p.work, 50)),
    workP95: r1(pct(p.work, 95)),
    workMax: r1(Math.max(...p.work)),
    p50: r1(pct(p.keys, 50)),
    p95: r1(pct(p.keys, 95)),
    max: r1(Math.max(...p.keys)),
    over16: p.keys.filter((x) => x > 16).length,
    commitsPerKey: r1(p.commits / KEYS),
    rendersPerKey: r1(p.renders / KEYS),
    longTasks: p.longtasks.length,
    longTaskMs: Math.round(p.longtasks.reduce((a, b) => a + b, 0)),
    // Main-thread time per key by kind (DevTools Performance.getMetrics), live traffic included.
    msPerKey: { script: perKey('ScriptDuration'), style: perKey('RecalcStyleDuration'), layout: perKey('LayoutDuration'), task: perKey('TaskDuration') },
  };
}

async function idle(page: Page, cdp: CDPSession) {
  await page.evaluate(() => {
    const p = (window as unknown as { __perf: Perf }).__perf;
    p.commits = 0;
    p.longtasks = [];
  });
  const m0 = await metrics(cdp);
  await page.waitForTimeout(IDLE_S * 1000);
  const m1 = await metrics(cdp);
  const d = (k: string) => m1[k] - m0[k];
  const p = await page.evaluate(() => (window as unknown as { __perf: Perf }).__perf);
  return {
    seconds: IDLE_S,
    busyPct: r1((d('TaskDuration') / IDLE_S) * 100),
    scriptPct: r1((d('ScriptDuration') / IDLE_S) * 100),
    commitsPerSec: r1(p.commits / IDLE_S),
    // A page that lays itself out every frame with nothing happening (an animation of a layout property) shows here.
    layoutsPerSec: r1(d('LayoutCount') / IDLE_S),
    longTasks: p.longtasks.length,
  };
}

async function main() {
  const mock = await startMock();
  const browser = await chromium.launch();
  try {
    const stateRes = await fetch(`http://127.0.0.1:${PORT}/api/state`);
    const stateBytes = (await stateRes.arrayBuffer()).byteLength;
    const state = JSON.parse(await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).text());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(INIT);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
    const t = Date.now();
    await page.goto(`http://127.0.0.1:${PORT}/${ROUTE}`);
    // A slow build on a throttled CPU can take a while to show thousands of agents.
    await page.locator('.composer-input').first().waitFor({ timeout: 120_000 });
    await page.locator('.transcript .msg').first().waitFor({ timeout: 120_000 });
    const firstUsableMs = Date.now() - t;
    await page.waitForTimeout(2000);
    const domNodes = await page.evaluate(() => document.getElementsByTagName('*').length);

    const result: Record<string, unknown> = {
      setup: { route: ROUTE || 'home', cpuThrottle: CPU, liveEventsPerSec: Number(LIVE), sessions: state.sessions.length, ledger: (state.work ?? []).length, keys: KEYS, keyGapMs: KEY_GAP },
      payload: { stateKB: Math.round(stateBytes / 1024), firstUsableMs, domNodes },
      typing: await typing(page, cdp),
      idle: await idle(page, cdp),
    };
    if (MEMORY_MIN > 0) {
      const samples: number[] = [r1(await heapMB(cdp))];
      for (let m = 1; m <= MEMORY_MIN; m++) {
        await page.waitForTimeout(60_000);
        samples.push(r1(await heapMB(cdp)));
        console.error(`memory ${m}/${MEMORY_MIN} min: ${samples.at(-1)} MB`);
      }
      result.memory = { minutes: MEMORY_MIN, heapMB: samples, growthMB: r1(samples.at(-1)! - samples[0]) };
    }
    result.heapMB = r1(await heapMB(cdp));
    console.log(JSON.stringify(result, null, 2));
    if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
    if (CHECK) {
      const t = result.typing as Awaited<ReturnType<typeof typing>>;
      const i = result.idle as Awaited<ReturnType<typeof idle>>;
      const broken = [
        t.rendersPerKey > BUDGET.rendersPerKey && `${t.rendersPerKey} components rendered per key (budget ${BUDGET.rendersPerKey})`,
        (result.payload as { domNodes: number }).domNodes > BUDGET.domNodes && `${(result.payload as { domNodes: number }).domNodes} DOM nodes (budget ${BUDGET.domNodes})`,
        t.workP95 > BUDGET.workP95Ms * CPU && `typing p95 ${t.workP95} ms (budget ${BUDGET.workP95Ms * CPU})`,
        t.longTasks > BUDGET.longTasksTyping && `${t.longTasks} long tasks while typing (budget ${BUDGET.longTasksTyping})`,
        Number(LIVE) === 0 && i.layoutsPerSec > BUDGET.layoutsPerSecIdle && `${i.layoutsPerSec} layouts per second with nothing happening (budget ${BUDGET.layoutsPerSecIdle})`,
      ].filter(Boolean);
      for (const b of broken) console.error(`perf budget broken: ${b}`);
      if (broken.length) process.exitCode = 1;
      else console.error('perf budgets met');
    }
  } finally {
    await browser.close();
    mock.kill();
  }
}

await main();
