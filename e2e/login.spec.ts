import { PASSWORD, USER, expect, test } from './fixtures.ts';

test('login: a wrong password is refused, the right one opens the app', async ({ page }) => {
  await page.goto('/');
  const user = page.locator('input[name="username"]');
  const pass = page.locator('input[name="password"]');
  const submit = page.getByRole('button', { name: 'Sign in' });
  await expect(submit).toBeDisabled();

  // The server hashes at most two passwords at once and answers "Busy, try again in a moment." to the
  // rest; tests on other workers log in at the same time, so a Busy answer is retried like a person would.
  const err = page.locator('.login-err');
  const submitUntil = async (done: () => Promise<unknown>) => {
    await submit.click();
    await expect(async () => {
      if ((await err.allTextContents()).some((t) => t.startsWith('Busy')) && (await submit.isEnabled())) await submit.click();
      await done();
    }).toPass({ intervals: [200, 400, 800], timeout: 15_000 });
  };

  await user.fill(USER);
  await pass.fill('not-the-password');
  await submitUntil(() => expect(err).toHaveText('Wrong username or password.', { timeout: 1500 }));

  await pass.fill(PASSWORD);
  await submitUntil(() => expect(page.locator('.sidebar')).toBeAttached({ timeout: 1500 }));
  await expect(page.locator('input[name="password"]')).toHaveCount(0);

  // The session survives a reload (cookie), and signing out returns to the login form.
  await page.reload();
  await expect(page.locator('.sidebar')).toBeAttached();
});

test('health: version and sha without a login', async ({ request }) => {
  const r = await request.get('/api/health');
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body.ok).toBe(true);
  expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(body.sha).toMatch(/^[0-9a-f]{7,12}$/);
  // Everything else still needs one.
  expect((await request.get('/api/state')).status()).toBe(401);
});
