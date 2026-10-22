import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (e2e/*.spec.ts) against the real server with a scripted fake agent (e2e/server.ts).
 * Each browser project gets its own server and data folder, so projects never see each other's state.
 *
 *   npm --prefix web run build     # the server serves web/dist
 *   npm run test:e2e               # all projects;  -- --project=desktop-chromium  for one
 */
const CI = !!process.env.CI;
// Screenshots render differently per OS (fonts), and the committed baselines are CI's Linux ones: other
// systems skip the comparison unless E2E_SNAPSHOTS=1 (with baselines of their own).
const SNAPSHOTS = process.platform === 'linux' || process.env.E2E_SNAPSHOTS === '1';

// Chrome for iOS on an iPad: WebKit (every iOS browser is), with Chrome's user agent.
const CHROME_IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.122 Mobile/15E148 Safari/604.1';

const IPAD = /ipad\.spec\.ts/;
// FFBox's card and page (e2e/provider.spec.ts) run on servers of their own with the provider switched on
// (E2E_PROVIDER=1), so the sidebar every other test and snapshot sees stays as it was.
const PROVIDER = /provider\.spec\.ts/;
// The intake (e2e/intake.spec.ts) likewise, with the Discord intake switched on (E2E_INTAKE=1).
const INTAKE = /intake\.spec\.ts/;
// What Firefox runs (w1419): how images and clips show in a chat.
const FIREFOX = /(images|video|ask)\.spec\.ts/;
// Chrome on an Android phone runs only what a phone does differently (w1191; Ben, 2026-10-13: "I approve everything"):
// attachments (Android's file picker, w528), the chat and its composer, replies by tap, the chat keeping its place
// (w1100, w1164), rotation, the phone layout and its screenshots. Every other spec runs on desktop Chromium (the engine)
// and on the iPhone (the phone layout, 390 px against the Pixel's 393), which was 159 of mobile-chrome's 290 test-seconds.
const ANDROID = /(attachments|chat|composerClears|replies|rotate|scrollKeep|layout|visual)\.spec\.ts/;

const PROJECTS = [
  { name: 'desktop-chromium', port: 8791, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  // Pixel 5: 393 px wide, Chrome on Android.
  { name: 'mobile-chrome', port: 8792, use: { ...devices['Pixel 5'] }, only: ANDROID },
  // iPhone 13: 390 px wide, WebKit (Safari's engine).
  { name: 'mobile-safari', port: 8793, use: { ...devices['iPhone 13'] } },
  // iPad Pro 11 (834 x 1194), in Safari and in Chrome: the iPad tests only (e2e/ipad.spec.ts). Both run on the WebKit engine:
// ipad-chrome is the iPad device with Chrome's user agent (iOS Chrome is WebKit too), so ci.yml puts it in the WebKit leg.
  { name: 'ipad-safari', port: 8794, use: { ...devices['iPad Pro 11'] }, only: IPAD },
  { name: 'ipad-chrome', port: 8795, use: { ...devices['iPad Pro 11'], userAgent: CHROME_IPAD_UA }, only: IPAD },
  { name: 'provider-desktop', port: 8796, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, only: PROVIDER, env: { E2E_PROVIDER: '1' } },
  { name: 'provider-mobile', port: 8797, use: { ...devices['Pixel 5'] }, only: PROVIDER, env: { E2E_PROVIDER: '1' } },
  { name: 'intake-desktop', port: 8798, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, only: INTAKE, env: { E2E_INTAKE: '1' } },
  { name: 'intake-mobile', port: 8799, use: { ...devices['iPhone 13'] }, only: INTAKE, env: { E2E_INTAKE: '1' } },
  // Firefox on a desktop (w1419: Ben reads the portal in Firefox, and its stills were the ones that failed): the image, video
  // and question specs. Opt-in (E2E_FIREFOX=1, its browser installed) until ci.yml's Chromium leg lists it: a ci.yml change
  // needs a token with GitHub's workflow scope (scripts/e2e-legs.test.ts checks every project here is in a leg).
  ...(process.env.E2E_FIREFOX === '1' ? [{ name: 'desktop-firefox', port: 8800, use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } }, only: FIREFOX }] : []),
] as { name: string; port: number; use: Record<string, unknown>; only?: RegExp; env?: Record<string, string> }[];

// E2E_PROJECTS=a,b runs only those projects and starts only their servers (ci.yml runs one browser engine per job, w1191).
// --project alone would not do: Playwright starts every webServer in the config whatever it runs. Unset: every project.
// A name that is no project fails here, so a renamed project cannot drop out of CI unseen (scripts/e2e-legs.test.ts checks
// that ci.yml's legs name every project once).
const PICKED = (process.env.E2E_PROJECTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const unknown = PICKED.filter((n) => !PROJECTS.some((p) => p.name === n));
if (unknown.length) throw new Error(`E2E_PROJECTS names no such project: ${unknown.join(', ')}`);
const ACTIVE = PICKED.length ? PROJECTS.filter((p) => PICKED.includes(p.name)) : PROJECTS;
// w1758 EXPERIMENT: the scroll, freshness and replies specs again, 4 times each, on the same servers while the suite runs.
const REPEAT = /(scrollKeep|freshness|replies)\.spec\.ts/;
const REPS = ACTIVE.filter((p) => p.name === 'desktop-chromium' || p.name === 'mobile-safari').map((p) => ({ ...p, name: `${p.name}-rep`, only: REPEAT, repeatEach: 4 }));

/** Every project's name, for scripts/e2e-legs.test.ts. */
export const PROJECT_NAMES = PROJECTS.map((p) => p.name);

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  timeout: 30_000,
  expect: {
    timeout: 7_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, threshold: 0.25, animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  // Snapshots are rendered per OS (fonts differ); CI's are the Linux ones.
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}-{platform}{ext}',
  ignoreSnapshots: !SNAPSHOTS,
  fullyParallel: false,
  workers: CI ? 3 : undefined,
  retries: CI ? 1 : 0,
  forbidOnly: CI,
  reporter: CI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list'], ['html', { open: 'never' }]],
  use: {
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [...ACTIVE, ...REPS].map((p) => ({
    ...('repeatEach' in p ? { repeatEach: p.repeatEach as number } : {}),
    name: p.name,
    use: { ...p.use, baseURL: `http://127.0.0.1:${p.port}` },
    ...(p.only ? { testMatch: p.only } : { testIgnore: [IPAD, PROVIDER, INTAKE] }),
  })),
  webServer: ACTIVE.map((p) => ({
    command: 'node e2e/server.ts',
    url: `http://127.0.0.1:${p.port}/api/health`,
    env: { E2E_PORT: String(p.port), ...p.env },
    reuseExistingServer: !CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  })),
});
