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

const PROJECTS = [
  { name: 'desktop-chromium', port: 8791, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  // Pixel 5: 393 px wide, Chrome on Android.
  { name: 'mobile-chrome', port: 8792, use: { ...devices['Pixel 5'] } },
  // iPhone 13: 390 px wide, WebKit (Safari's engine).
  { name: 'mobile-safari', port: 8793, use: { ...devices['iPhone 13'] } },
  // iPad Pro 11 (834 x 1194), in Safari and in Chrome: the iPad tests only (e2e/ipad.spec.ts).
  { name: 'ipad-safari', port: 8794, use: { ...devices['iPad Pro 11'] }, only: IPAD },
  { name: 'ipad-chrome', port: 8795, use: { ...devices['iPad Pro 11'], userAgent: CHROME_IPAD_UA }, only: IPAD },
  { name: 'provider-desktop', port: 8796, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, only: PROVIDER, env: { E2E_PROVIDER: '1' } },
  { name: 'provider-mobile', port: 8797, use: { ...devices['Pixel 5'] }, only: PROVIDER, env: { E2E_PROVIDER: '1' } },
  { name: 'intake-desktop', port: 8798, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, only: INTAKE, env: { E2E_INTAKE: '1' } },
  { name: 'intake-mobile', port: 8799, use: { ...devices['iPhone 13'] }, only: INTAKE, env: { E2E_INTAKE: '1' } },
] as { name: string; port: number; use: Record<string, unknown>; only?: RegExp; env?: Record<string, string> }[];

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
  projects: PROJECTS.map((p) => ({
    name: p.name,
    use: { ...p.use, baseURL: `http://127.0.0.1:${p.port}` },
    ...(p.only ? { testMatch: p.only } : { testIgnore: [IPAD, PROVIDER, INTAKE] }),
  })),
  webServer: PROJECTS.map((p) => ({
    command: 'node e2e/server.ts',
    url: `http://127.0.0.1:${p.port}/api/health`,
    env: { E2E_PORT: String(p.port), ...p.env },
    reuseExistingServer: !CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  })),
});
