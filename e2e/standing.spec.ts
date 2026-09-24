import { expect, openSidebar, startWorker, test, uniq } from './fixtures.ts';

test('standing agents: create, edit, run by hand, pause and resume, delete', async ({ authed: page }) => {
  const name = `Triage ${uniq('sa')}`;

  // Create (manual schedule: nothing runs by itself).
  let sidebar = await openSidebar(page);
  await sidebar.locator('.section-head', { hasText: 'Standing agents' }).getByRole('button', { name: 'New' }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.locator('.modal-head h2')).toHaveText('New standing agent');
  const create = modal.getByRole('button', { name: 'Create agent' });
  await expect(create).toBeDisabled();
  await modal.getByPlaceholder('Discord triage').fill(name);
  await modal.locator('textarea').fill('Check the build folder and say what you found.');
  await modal.locator('label.field', { hasText: 'Runs' }).locator('select').selectOption('manual');
  await expect(create).toBeEnabled();
  await create.click();
  await expect(modal).toBeHidden();
  // On a phone the drawer the modal was opened from closes, so the new page is in view.
  await expect(page.locator('.shell.drawer-open')).toHaveCount(0);

  // Its page opens.
  const panel = page.locator('.sa-panel');
  await expect(panel.locator('h2')).toHaveText(name);
  await expect(page).toHaveURL(/#\/agent\/[\w-]+$/);
  await expect(panel.locator('.sa-charter')).toHaveText('Check the build folder and say what you found.');
  await expect(panel.locator('.sb-facts')).toContainText('opus');
  await expect(panel.getByRole('tab', { name: /Runs/ })).toContainText('0');

  // It is listed in the sidebar.
  sidebar = await openSidebar(page);
  const card = sidebar.locator('.row.place', { hasText: name });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Runs by hand');
  await card.click();
  await expect(panel.locator('h2')).toHaveText(name);

  // Edit: rename and a new charter.
  const renamed = `${name} v2`;
  await panel.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog');
  await expect(edit.locator('.modal-head h2')).toHaveText(`Edit ${name}`);
  await edit.getByPlaceholder('Discord triage').fill(renamed);
  await edit.locator('textarea').fill('Look at the open PRs and summarise them.');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();
  await expect(panel.locator('h2')).toHaveText(renamed);
  await expect(panel.locator('.sa-charter')).toHaveText('Look at the open PRs and summarise them.');

  // Run now: the fake agent answers and the run is booked.
  await panel.getByRole('button', { name: 'Run now' }).click();
  const last = panel.locator('.sa-last');
  await expect(last.locator('.chip')).toHaveText('Done', { timeout: 15_000 });
  await expect(last).toContainText('manual');
  await expect(panel.getByRole('tab', { name: /Runs/ })).toContainText('1');
  await expect(panel.locator('.run-row')).toHaveCount(1);
  await panel.getByRole('tab', { name: 'Conversation' }).click();
  await expect(page).toHaveURL(/\/conversation$/);
  await expect(panel.locator('.msg-assistant', { hasText: 'Echo:' }).first()).toBeVisible();
  await panel.getByRole('tab', { name: /Runs/ }).click();

  // Pause and resume.
  await panel.getByRole('button', { name: 'Pause' }).click();
  await expect(panel.getByRole('button', { name: 'Resume' })).toBeVisible();
  await expect(panel.locator('.unity-bar')).toContainText('no scheduled runs');
  await panel.getByRole('button', { name: 'Resume' }).click();
  await expect(panel.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(panel.locator('.unity-bar')).toContainText('runs when started by hand');

  // Delete: gone from its page and the sidebar.
  await panel.getByRole('button', { name: 'Delete agent' }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm.locator('.modal-head h2')).toHaveText(`Delete ${renamed}?`);
  await confirm.getByRole('button', { name: 'Delete agent' }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.row.place', { hasText: name })).toHaveCount(0);
  expect((await page.request.get('/api/state').then((r) => r.json())).standingAgents.some((a: { name: string }) => a.name === renamed)).toBe(false);
});

test('a modal keeps the focus where the user put it while the app state changes', async ({ authed: page }) => {
  const sidebar = await openSidebar(page);
  await sidebar.locator('.section-head', { hasText: 'Standing agents' }).getByRole('button', { name: 'New' }).click();
  const modal = page.getByRole('dialog');
  // It opens with the first field focused.
  await expect(modal.getByPlaceholder('Discord triage')).toBeFocused();
  const charter = modal.locator('textarea');
  await charter.click();
  await expect(charter).toBeFocused();

  // Something else happens meanwhile (an agent starts and answers): the app re-renders.
  const tag = uniq('focus');
  await startWorker(page.request, `hello ${tag}`, { title: `Focus ${tag}` });
  // The sandbox's row lists its agents in its tooltip once the new one has arrived.
  await expect(page.locator(`.row.place[title*="Focus ${tag}"]`)).toBeAttached();
  await expect(charter).toBeFocused();
  await charter.pressSequentially('abc');
  await expect(charter).toHaveValue('abc');
  await expect(modal.getByPlaceholder('Discord triage')).toHaveValue('');
});
