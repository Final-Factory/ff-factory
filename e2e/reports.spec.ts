import { appState, expect, go, patchWork, test, uniq, useTool } from './fixtures.ts';

/**
 * Reports (w2541, docs/reports.md) on the dispatcher's Reports tab: e2e/server.ts seeds a profile (two revisions, a kept
 * still) asked by Tester and a design asked by Team Mate. The list shows each with its operator and filters by kind,
 * operator and words; a row opens its page with its Markdown, its still, its revisions and a link to its request; a
 * request links to its reports.
 */
test('the Reports tab lists reports with their operators, filters them, and a report page shows its text, still and revisions', async ({ authed: page }) => {
  await go(page, '#/dispatcher/reports');
  const panel = page.locator('.dispatcher-panel');
  const list = panel.getByTestId('reports-list');
  await expect(list.getByTestId('report-r1')).toContainText('Belt render profile');
  await expect(list.getByTestId('report-operator-r1')).toHaveText('Tester');
  await expect(list.getByTestId('report-operator-r2')).toHaveText('Team Mate');
  await expect(list.getByTestId('report-r1')).toContainText('2 revisions');
  if (test.info().project.name === 'desktop-chromium') await panel.screenshot({ path: test.info().outputPath('reports-tab.png') });

  // Filters: a kind, an operator, words (the server's full-text search, with the matching text).
  await panel.getByTestId('reports-kind-design').click();
  await expect(list.locator('.report-row')).toHaveCount(1);
  await expect(list.getByTestId('report-r2')).toBeVisible();
  await panel.getByTestId('reports-kind-design').click();
  await panel.getByTestId('reports-person').selectOption('Tester');
  await expect(list.locator('.report-row')).toHaveCount(1);
  await expect(list.getByTestId('report-r1')).toBeVisible();
  await panel.getByTestId('reports-person').selectOption('');
  await panel.getByTestId('reports-search').fill('round robin');
  await expect(list.locator('.report-row')).toHaveCount(1);
  await expect(list.getByTestId('report-r2')).toContainText('Round robin');
  await panel.getByTestId('reports-search').fill('');

  // The page: its operator, its request, its still from the kept media, and its older revision.
  await list.getByTestId('report-r1').getByRole('link').click();
  const report = panel.getByTestId('report-page-r1');
  await expect(report.getByTestId('report-operator')).toHaveText('Tester');
  await expect(report.getByTestId('report-request')).toHaveAttribute('href', '#/dispatcher/w9001');
  await expect(report.locator('td', { hasText: '62' })).toBeVisible();
  const still = report.locator('img').first();
  await expect(still).toHaveAttribute('src', /^\/api\/reports\/r1\/media\//);
  await expect.poll(() => still.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  if (test.info().project.name === 'desktop-chromium') await panel.screenshot({ path: test.info().outputPath('report-page.png') });
  await report.getByTestId('report-revision').selectOption('1');
  await expect(report.locator('td', { hasText: '71' })).toBeVisible();
  await expect(report).toContainText('An older revision');
  await report.getByTestId('report-back').click();
  await expect(list).toBeVisible();
});

test('a request links to its reports, and one marked as needing a report says none is filed yet (w2541)', async ({ authed: page }) => {
  const tag = uniq('report');
  const me = await appState(page.request);
  const filed = await useTool(page.request, me.orchestratorId, 'request_work', { title: `Profile the inserters ${tag}`, brief: `Where the time goes ${tag}.`, report: 'profile' });
  expect(filed).toContain('its result is a report (profile)');
  const id = filed.match(/Filed (w\d+)/)![1];
  await go(page, `#/dispatcher/${id}`);
  const row = page.locator('.dispatcher-panel').getByTestId(`work-${id}`);
  await expect(row.getByTestId(`work-report-due-${id}`)).toContainText('none filed yet');
  await patchWork(page.request, id, { reports: [{ id: 'r1', title: 'Belt render profile on a 1000-belt save', kind: 'profile' }] });
  const link = row.getByTestId('work-reports').getByRole('link', { name: /r1/ });
  await expect(link).toHaveAttribute('href', '#/dispatcher/r1');
  await link.click();
  await expect(page.getByTestId('report-page-r1')).toBeVisible();
});
