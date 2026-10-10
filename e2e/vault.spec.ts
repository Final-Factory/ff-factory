import { randomBytes } from 'node:crypto';
import { request as pwRequest } from '@playwright/test';
import { expect, openSidebar, test, uniq } from './fixtures.ts';
import type { VaultView } from '../shared/types.ts';

/**
 * The token vault (docs/vault.md, w512): an owner adds a secret in the settings sheet, sees its fingerprint and last four
 * characters only, and removes it; a member cannot reach the vault at all. The e2e server has a key (e2e/server.ts).
 */

test('vault: only an owner reaches it; a member gets 403', async ({ authed: page }) => {
  const r = await page.request.get('/api/vault');
  expect(r.ok()).toBeTruthy();
  expect(((await r.json()) as VaultView).status.key).toBe('loaded');
  const mate = await pwRequest.newContext({ baseURL: test.info().project.use.baseURL });
  await expect(async () => {
    const l = await mate.post('/api/login', { data: { username: 'teammate', password: 'e2e-teammate-456' } });
    expect(l.ok(), await l.text()).toBeTruthy();
  }).toPass({ intervals: [100, 200, 400, 800], timeout: 15_000 });
  for (const call of [mate.get('/api/vault'), mate.post('/api/vault', { data: { name: 'x', kind: 'env', env: 'X_TOKEN', value: 'abcdefgh', share: 'anyone' } }), mate.delete('/api/vault/x')]) {
    expect((await call).status()).toBe(403);
  }
  await mate.dispose();
});

test('vault: add a secret in the settings sheet; it shows only its last four, never comes back, and goes', async ({ authed: page }) => {
  const name = uniq('v').toLowerCase().replace(/[^a-z0-9-]/g, '');
  const value = randomBytes(18).toString('base64url');
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: 'Settings' }).click();
  const vault = page.locator('.modal').getByTestId('vault');
  await expect(vault.getByTestId('vault-key')).toHaveText('Key loaded');
  await vault.getByRole('button', { name: 'Add a token' }).click();
  await vault.getByLabel('name').fill(name);
  await vault.getByLabel('kind').selectOption('env');
  await vault.getByLabel('variable').fill('FFE2E_TOKEN');
  await vault.getByLabel('share').selectOption('anyone');
  await vault.getByLabel('machines').fill('m3');
  await vault.getByLabel('value').fill(value);
  const added = page.waitForResponse((r) => r.url().endsWith('/api/vault') && r.request().method() === 'POST');
  await vault.getByRole('button', { name: 'Add', exact: true }).click();
  const res = await added;
  expect(res.ok(), await res.text()).toBeTruthy();
  expect(await res.text()).not.toContain(value);
  const row = vault.getByTestId(`vault-${name}`);
  await expect(row).toContainText(`…${value.slice(-4)}`);
  await expect(row).toContainText('FFE2E_TOKEN');
  await expect(row).toContainText('any run; workers, standing on m3');
  // The row shows as soon as the list comes back; the add form (a controlled input, whose value attribute holds the
  // typed token) closes a tick later. page.content() read in between found the token (WebKit, 2026-10-09).
  await expect(vault.getByLabel('value')).toHaveCount(0);
  expect(await page.content()).not.toContain(value);
  expect(await (await page.request.get('/api/vault')).text()).not.toContain(value);

  await row.getByRole('button', { name: 'Remove' }).click();
  await row.getByRole('button', { name: 'Really remove?' }).click();
  await expect(row).toHaveCount(0);
});

test('vault (w785): a Claude token takes the account email at add time; it can be set, changed and cleared afterwards without the token; absent shows "email not recorded"', async ({ authed: page }) => {
  const name = `vault-e2e-${uniq('c').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)}`;
  const value = `sk-ant-oat01-${randomBytes(40).toString('base64url')}`;
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: 'Settings' }).click();
  const vault = page.locator('.modal').getByTestId('vault');
  await vault.getByRole('button', { name: 'Add a token' }).click();
  await vault.getByLabel('name').fill(name);
  await vault.getByLabel('kind').selectOption('claude');
  await vault.getByLabel('share').selectOption('anyone');
  await vault.getByLabel('account email').fill('e2e.one@example.com');
  await vault.getByLabel('value').fill(value);
  const added = page.waitForResponse((r) => r.url().endsWith('/api/vault') && r.request().method() === 'POST');
  await vault.getByRole('button', { name: 'Add', exact: true }).click();
  expect((await added).ok()).toBeTruthy();
  const row = vault.getByTestId(`vault-${name}`);
  await expect(row.getByTestId(`vault-email-${name}`)).toHaveText('e2e.one@example.com');
  // changed afterwards through Grant: the same entry, no token typed again
  await row.getByRole('button', { name: 'Grant' }).click();
  await row.getByLabel('account email').fill('e2e.two@example.com');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByTestId(`vault-email-${name}`)).toHaveText('e2e.two@example.com');
  // cleared: nothing is invented
  await row.getByRole('button', { name: 'Grant' }).click();
  await row.getByLabel('account email').fill('');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByTestId(`vault-email-${name}`)).toHaveText('email not recorded');
  // a bad address is refused by the server and changes nothing
  const bad = await page.request.patch(`/api/vault/${name}`, { data: { email: 'not an address' } });
  expect(bad.status()).toBe(400);
  expect(await (await page.request.get('/api/vault')).text()).not.toContain(value);
  await row.getByRole('button', { name: 'Remove' }).click();
  await row.getByRole('button', { name: 'Really remove?' }).click();
  await expect(row).toHaveCount(0);
});
