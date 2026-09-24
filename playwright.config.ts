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

const PROJECTS = [
  { name: 'desktop-chromium', port: 8791, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  // Pixel 5: 393 px wide, Chrome on Android.
  { name: 'mobile-chrome', port: 8792, use: { ...devices['Pixel 5'] } },
  // iPhone 13: 390 px wide, WebKit (Safari's engine).
  { name: 'mobile-safari', port: 8793, use: { ...devices['iPhone 13'] } },
  // iPad Pro 11 (834 x 1194), in Safari and in Chrome: the iPad tests only (e2e/ipad.spec.ts).
  { name: 'ipad-safari', port: 8794, use: { ...devices['iPad Pro 11'] }, ipad: true },
  { name: 'ipad-chrome', port: 8795, use: { ...devices['iPad Pro 11'], userAgent: CHROME_IPAD_UA }, ipad: true },
];

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
    ...(p.ipad ? { testMatch: IPAD } : { testIgnore: IPAD }),
  })),
  webServer: PROJECTS.map((p) => ({
    command: 'node e2e/server.ts',
    url: `http://127.0.0.1:${p.port}/api/health`,
    env: { E2E_PORT: String(p.port) },
    reuseExistingServer: !CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  })),
});
