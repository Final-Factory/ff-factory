import { NOTIFY_KINDS } from '../shared/types.ts';
import { appState, expect, openSidebar, sendToChat, signIn, test, uniq } from './fixtures.ts';

/**
 * Web Push needs a real push service, so the browser's side of it is stubbed: permission is granted
 * and PushManager hands out a fake subscription (an https endpoint and keys, as the server checks).
 * The service worker registration itself is real.
 */
function stubPush() {
  const w = window as unknown as { __push: { sub: unknown; permission: NotificationPermission } };
  const state = (w.__push = { sub: null as unknown, permission: 'default' as NotificationPermission });
  Object.defineProperty(Notification, 'permission', { configurable: true, get: () => state.permission });
  Notification.requestPermission = async () => (state.permission = 'granted');
  const makeSub = () => {
    const endpoint = `https://push.example.test/e2e/${Math.random().toString(36).slice(2)}`;
    const keys = { p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U', auth: 'tBHItJI5svbpez7KI4CCXg' }; // gitleaks:allow (a made-up test subscription)
    return {
      endpoint,
      expirationTime: null,
      options: { userVisibleOnly: true },
      getKey: () => null,
      toJSON: () => ({ endpoint, expirationTime: null, keys }),
      unsubscribe: async () => {
        state.sub = null;
        return true;
      },
    };
  };
  PushManager.prototype.getSubscription = async function () {
    return state.sub as PushSubscription | null;
  };
  PushManager.prototype.subscribe = async function () {
    state.sub = makeSub();
    return state.sub as PushSubscription;
  };
}

const OFF_TEXT = 'Off on this device: no notifications, from the browser or from this page.';

/**
 * Records every notification the page asks the browser to show (the service worker's showNotification, or a page's own
 * `new Notification`) in window.__shown, and shows none; the tab counts as in the background (w1660).
 */
function recordNotifications() {
  const w = window as unknown as { __shown: string[] };
  w.__shown = [];
  ServiceWorkerRegistration.prototype.showNotification = async (title: string) => void w.__shown.push(title);
  window.Notification = new Proxy(window.Notification, {
    construct(_t, args) {
      w.__shown.push(String(args[0]));
      return {} as Notification;
    },
  });
  document.hasFocus = () => false;
}

/** A browser with Web Push: the stubbed one above. Without: the in-tab fallback (Firefox on some systems, or an old Android WebView). */
function noPushManager() {
  delete (window as unknown as Record<string, unknown>).PushManager;
  Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
  Notification.requestPermission = async () => 'granted';
}

/** The orchestrator finishes a turn, which is a `notify` event to every open page of its person. */
async function finishATurn(page: import('@playwright/test').Page) {
  const tag = uniq('notify');
  await sendToChat(page.request, (await appState(page.request)).orchestratorId, `hello ${tag}`);
  await expect(page.locator('.orch .msg-assistant', { hasText: `Echo: hello ${tag}` })).toBeVisible();
}

interface ServiceWorkerGlobalScopeLike {
  dispatchEvent(e: Event): boolean;
  addEventListener(type: 'push', l: (e: Event & { waitUntil(p: Promise<unknown>): void }) => void, opts?: { once: boolean }): void;
  registration: { getNotifications(): Promise<unknown[]> };
}

const shown = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __shown: string[] }).__shown);

/** iPhone Safari outside a Home Screen app has no Web Push (Playwright's WebKit may differ by OS). */
function noPushLikeIosSafari() {
  const w = window as unknown as Record<string, unknown>;
  delete w.PushManager;
  delete w.Notification;
}

test('settings: notifications on and off, per-kind choices, and the version', async ({ page, browserName }) => {
  await page.addInitScript(browserName === 'webkit' ? noPushLikeIosSafari : stubPush);
  await signIn(page);
  await page.goto('/');

  const footer = page.getByTestId('app-version');
  await expect(footer).toHaveText(/^v\d+\.\d+\.\d+ · [0-9a-f]{7,12}$/);
  const version = (await footer.textContent())!;

  const sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: 'Settings' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.locator('.modal-head h2')).toHaveText('This device');
  await expect(sheet.getByTestId('about-version')).toContainText(`FF Factory ${version}`);
  await expect(sheet.getByTestId('about-version').getByRole('link', { name: 'changelog' })).toHaveAttribute('href', /CHANGELOG\.md$/);
  // Voice is turned off on this server: the sheet says so instead of offering it.
  await expect(sheet).toContainText('Local Whisper: unavailable (turned off in config.json (voice.enabled))');

  const status = sheet.locator('.form > p').first();
  const turnOn = sheet.getByRole('button', { name: 'Turn on' });

  if (browserName === 'webkit') {
    // iPhone: push only works from the Home Screen app, and the sheet says how to get there.
    await expect(status).toContainText('add FF Factory to the Home Screen first (Share → Add to Home Screen)');
    await expect(turnOn).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'Send a test' })).toHaveCount(0);
    // The choices still work locally (kept for when it is added to the Home Screen).
    const box = sheet.locator('.field', { hasText: 'Tell me when' }).getByRole('checkbox').first();
    const was = await box.isChecked();
    await box.click();
    await expect(box).toBeChecked({ checked: !was });
  } else {
    await expect(status).toHaveText(OFF_TEXT);
    const subscribed = page.waitForResponse((r) => r.url().endsWith('/api/push/subscribe') && r.ok());
    await turnOn.click();
    await subscribed;
    await expect(status).toHaveText('On: this device gets notifications even when FF Factory is closed.');
    await expect(sheet.getByRole('button', { name: 'Turn off' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Send a test' })).toBeVisible();

    // Each kind toggles and is saved on the server for this device.
    const boxes = sheet.locator('.field', { hasText: 'Tell me when' }).getByRole('checkbox');
    // One per kind the server knows (shared/types.ts), in its order.
    const kinds = NOTIFY_KINDS.map((k) => k.value);
    await expect(boxes).toHaveCount(kinds.length);
    for (const i of [0, 3]) {
      const box = boxes.nth(i);
      await expect(box).toBeChecked();
      for (const on of [false, true]) {
        const saved = page.waitForResponse((r) => r.url().endsWith('/api/push/prefs') && r.request().method() === 'POST');
        await box.click();
        const r = await saved;
        expect(r.ok()).toBeTruthy();
        expect(r.request().postDataJSON().prefs).toEqual({ [kinds[i]]: on });
        expect(((await r.json()) as { prefs: Record<string, boolean> }).prefs[kinds[i]]).toBe(on);
        await expect(box).toBeChecked({ checked: on });
      }
    }

    const unsubscribed = page.waitForResponse((r) => r.url().endsWith('/api/push/unsubscribe') && r.ok());
    await sheet.getByRole('button', { name: 'Turn off' }).click();
    await unsubscribed;
    await expect(status).toHaveText(OFF_TEXT);
    await expect(turnOn).toBeVisible();
  }

  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toBeHidden();
});

test('settings: after "Turn off" no notification is shown, by push or by the page (w1660)', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright WebKit has no Web Push to turn on');
  await page.addInitScript(stubPush);
  await page.addInitScript(recordNotifications);
  await signIn(page);
  await page.goto('/');
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: 'Settings' }).click();
  const sheet = page.getByRole('dialog');
  const subscribed = page.waitForResponse((r) => r.url().endsWith('/api/push/subscribe') && r.ok());
  await sheet.getByRole('button', { name: 'Turn on' }).click();
  await subscribed;
  const unsubscribed = page.waitForResponse((r) => r.url().endsWith('/api/push/unsubscribe') && r.ok());
  await sheet.getByRole('button', { name: 'Turn off' }).click();
  await unsubscribed;
  await expect(sheet.locator('.form > p').first()).toHaveText(OFF_TEXT);
  // The browser's permission is still granted: that alone must not make this page notify.
  expect(await page.evaluate(() => Notification.permission)).toBe('granted');
  await expect(sheet.getByRole('button', { name: 'Send a test' })).toHaveCount(0);

  await finishATurn(page);
  await page.waitForTimeout(500);
  expect(await shown(page)).toEqual([]);

  // The choice is this device's and survives a reload: the page boots off, and tells the service worker.
  await page.reload();
  await expect(page.locator('.sidebar')).toBeAttached();
  expect(await page.evaluate(() => localStorage.getItem('ffsb.notify.off'))).toBe('1');
  await finishATurn(page);
  await page.waitForTimeout(500);
  expect(await shown(page)).toEqual([]);
  // A push that still arrives for a subscription the person turned off is dropped by the service worker.
  const worker = page.context().serviceWorkers()[0] ?? (await page.context().waitForEvent('serviceworker'));
  await expect
    .poll(() => page.evaluate(async () => !!(await (await caches.open('ffsb-device')).match('/__notify-off'))))
    .toBe(true);
  const pushed = await worker.evaluate(async () => {
    const sw = self as unknown as ServiceWorkerGlobalScopeLike;
    await new Promise<void>((resolve) => {
      sw.addEventListener('push', (e) => e.waitUntil(new Promise((r) => setTimeout(r, 300)).then(() => resolve())), { once: true });
      sw.dispatchEvent(new (sw as unknown as { PushEvent: new (type: string, init: { data: string }) => Event }).PushEvent('push', { data: JSON.stringify({ title: 'must not show', body: '', url: '#/', tag: 'x' }) }));
    });
    return (await sw.registration.getNotifications()).length;
  });
  expect(pushed).toBe(0);

  // Turning it back on restores both the subscription and the notifications.
  await sidebar.getByRole('button', { name: 'Settings' }).click();
  const resubscribed = page.waitForResponse((r) => r.url().endsWith('/api/push/subscribe') && r.ok());
  await page.getByRole('dialog').getByRole('button', { name: 'Turn on' }).click();
  await resubscribed;
  expect(await page.evaluate(() => localStorage.getItem('ffsb.notify.off'))).toBeNull();
});

test('settings: a browser with no Web Push shows notices in the page until "Turn off" (w1660)', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright WebKit has no Notification to allow');
  await page.addInitScript(recordNotifications);
  await page.addInitScript(noPushManager);
  await signIn(page);
  await page.goto('/');
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: 'Settings' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.locator('.form > p').first()).toContainText('On in this tab only');

  // The control: the harness does see a page's own notification.
  await finishATurn(page);
  await expect.poll(() => shown(page)).not.toEqual([]);

  await sheet.getByRole('button', { name: 'Turn off' }).click();
  await expect(sheet.locator('.form > p').first()).toContainText('Allowing them lets this tab show them');
  const before = (await shown(page)).length;
  await finishATurn(page);
  await page.waitForTimeout(500);
  expect(await shown(page)).toHaveLength(before);

  await sheet.getByRole('button', { name: 'Turn on' }).click();
  await expect(sheet.locator('.form > p').first()).toContainText('On in this tab only');
  await finishATurn(page);
  await expect.poll(async () => (await shown(page)).length).toBeGreaterThan(before);
});


test("settings: the Claude pool row (w1717) is the signed-in operator's own, defaults to self, and offers every other operator's pool", async ({ page }) => {
  await signIn(page);
  await page.goto('/');
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: 'Settings' }).click();
  const pools = page.getByRole('dialog').getByTestId('pool-settings');
  await expect(pools).toContainText('Claude pool');
  // one row, the signed-in tester's own
  const mine = pools.getByRole('combobox', { name: 'Bill my work to' });
  await expect(pools.getByRole('combobox')).toHaveCount(1);
  await expect(mine).toHaveValue('self');
  // every other login with a Claude token is offered, and not the tester's own (that is "My own pool")
  await expect(mine.locator('option')).toContainText(['My own pool', 'Team Mate’s pool', 'Compact Tester’s pool', 'Ask Tester’s pool']);
  await expect(mine.locator('option', { hasText: /^tester’s pool$/i })).toHaveCount(0);
  // pick another operator's: the server keeps it under the tester's own id and the page hears it
  await mine.selectOption('teammate');
  await expect.poll(async () => (await appState(page.request)).settings.pool).toEqual({ tester: 'teammate' });
  await expect(mine).toHaveValue('teammate');
  // the server refuses what the menu never offers
  const bad = await page.request.post('/api/settings', { data: { pool: 'nobody' } });
  expect(bad.status()).toBe(400);
  expect(await bad.text()).toContain('nobody is not a login here');
  const shape = await page.request.post('/api/settings', { data: { pool: { person: 'teammate', from: 'tester' } } });
  expect(shape.status(), "only the caller's own: no person to name").toBe(400);
  // back to self: no key left
  await mine.selectOption('self');
  await expect.poll(async () => (await appState(page.request)).settings.pool).toEqual({});
});
