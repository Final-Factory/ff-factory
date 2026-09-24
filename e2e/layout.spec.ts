import { BOX, expect, expectFullyVisible, expectNoHorizontalOverflow, expectTapTargets, isMobile, openSandbox, openSidebar, settle, test } from './fixtures.ts';

// The main screens fit the viewport on every project; on a phone, the primary controls are at least
// 44 px (Apple's and Google's minimum touch target).

test('layout: orchestrator home', async ({ authed: page }) => {
  await expect(page.locator('.orch .composer-box')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectFullyVisible(page, '.orch .composer-box');
  if (!isMobile(page)) return;
  await expectTapTargets(page, '.orch .composer-actions .btn');
  // One header row on a phone: the drawer, the chat's state and its menu.
  await expectTapTargets(page, '.orch-head .btn');

  // The drawer: every row, its section buttons and the search and settings buttons.
  await openSidebar(page);
  await settle(page);
  await expectNoHorizontalOverflow(page);
  await expectFullyVisible(page, '.sidebar .side-head');
  await expectTapTargets(page, '.sidebar .row, .sidebar .side-head .btn, .sidebar .section-add, .sidebar .attn-item');
});

test('layout: a sandbox page', async ({ authed: page }) => {
  const panel = await openSandbox(page, 'gallery');
  await expect(panel.locator('.msg-assistant').first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectFullyVisible(page, '.sb-panel .composer-box');
  await expectFullyVisible(page, '.sb-panel .ph');
  if (!isMobile(page)) return;
  // The agent picker reads as text in the header's second line; its tap area is 44 px all the same.
  await expectTapTargets(page, '.sb-panel .composer-actions .btn, .sb-panel .ph .ph-btn, .sb-panel .agent-pick select');

  // With text in the box, Send takes the voice button's place: the same size.
  await panel.locator(BOX).fill('draft');
  await expect(panel.getByRole('button', { name: 'Send' })).toBeVisible();
  await expectTapTargets(page, '.sb-panel .composer-actions .btn');

  // The details sheet fits too.
  await panel.getByRole('button', { name: 'Details' }).click();
  await expect(page.getByRole('dialog', { name: 'Details' })).toBeVisible();
  await settle(page);
  await expectNoHorizontalOverflow(page);
  await expectFullyVisible(page, '.details-sheet');
  await expectTapTargets(page, '.details-sheet-head .btn');
});

test('layout: the settings sheet', async ({ authed: page }) => {
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: 'Settings' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByTestId('about-version')).toBeAttached();
  await settle(page);
  await expectNoHorizontalOverflow(page);
  await expectFullyVisible(page, '.modal .modal-head');
  await expectFullyVisible(page, '.modal .modal-foot');
  if (!isMobile(page)) return;
  await expectTapTargets(page, '.modal-head .btn, .modal-foot .btn');
  // The sheet scrolls down inside itself, never sideways (WebKit once let long select options push it).
  // (Allowing one scrollbar's width: desktop WebKit first lays the body out without its classic scrollbar.)
  const sideways = await sheet.locator('.modal-body').evaluate((el: HTMLElement) => {
    el.scrollLeft = 1000;
    const moved = el.scrollLeft;
    el.scrollLeft = 0;
    return { moved, gutter: el.offsetWidth - el.clientWidth };
  });
  expect(sideways.moved).toBeLessThanOrEqual(sideways.gutter);
});
