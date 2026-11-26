import { appState, ALPHA, expect, isMobile, sendMessage, startWorker, test, uniq, useTool } from './fixtures.ts';

/**
 * w6216: the ids an orchestrator names in its chat (a worker, a sandbox, a machine, a request) are links that open their
 * page in the right panel, the chat staying beside it on a desktop; unknown ids and ids in code stay text. The matcher's
 * own cases are server/idLinks.test.ts. With IDLINK_STILLS=<folder> the test also saves the stills the review looks at.
 */
test('ids in the orchestrator chat link to the worker, sandbox, machine and request, and open them beside the chat', async ({ authed: page }) => {
  const tag = uniq('idlink');
  const me = await appState(page.request);
  const filed = await useTool(page.request, me.orchestratorId, 'request_work', { title: `Get the portal working again ${tag}`, brief: `Linked from the chat ${tag}.` });
  const wid = filed.match(/Filed (w\d+)/)![1];
  const worker = await startWorker(page.request, `Fix the portal ${tag}`, { title: `Portal fix ${tag}` });
  const short = worker.id.slice(0, 8);
  const [machine, sandbox] = ALPHA.split('/');
  await sendMessage(
    page.request,
    me.orchestratorId,
    `A worker has started on ${wid} (getting the portal working again, ${tag}). It's worker ${short}, running on ${machine.toUpperCase()} in ${ALPHA}. Not linked: w99999999, deadbeef, \`${wid}\`.`,
  );
  const msg = page.locator('.orch .msg-assistant', { hasText: `Echo: A worker has started on ${wid}` }).filter({ hasText: tag });
  await expect(msg).toBeVisible();
  const links = msg.locator('a.id-link');
  await expect(links).toHaveText([wid, short, machine.toUpperCase(), ALPHA]);
  await expect(links.nth(0)).toHaveAttribute('href', `#/dispatcher/${wid}`);
  await expect(links.nth(1)).toHaveAttribute('href', `#/machine/${machine}/sandbox/${sandbox}/${worker.id}`);
  await expect(links.nth(2)).toHaveAttribute('href', `#/machine/${machine}`);
  await expect(links.nth(3)).toHaveAttribute('href', `#/machine/${machine}/sandbox/${sandbox}`);
  // The id in a code span stays code, and ids nobody has stay text.
  await expect(msg.locator('code', { hasText: wid })).toHaveCount(1);
  await expect(msg.locator('a', { hasText: 'w99999999' })).toHaveCount(0);
  await expect(msg.locator('a', { hasText: 'deadbeef' })).toHaveCount(0);

  const stills = process.env.IDLINK_STILLS;
  const shot = async (name: string) => {
    if (stills) await page.screenshot({ path: `${stills}/${test.info().project.name}-${name}.png` });
  };
  await msg.scrollIntoViewIfNeeded();
  await shot('1-chat-links');

  const mobile = isMobile(page);
  // The worker: its sandbox's page with the worker open, in the right panel; on a desktop the chat stays beside it.
  await links.nth(1).click();
  await expect(page).toHaveURL(new RegExp(`#/machine/${machine}/sandbox/${sandbox}/${worker.id}$`));
  await expect(page.getByTestId('machine-sandbox-panel')).toBeVisible();
  if (!mobile) await expect(page.locator('.orch.orch-compact')).toBeVisible();
  await shot('2-worker-panel');

  // The request, from the chat beside the panel on a desktop (back to the chat first on a phone): the Requests tab with
  // its row open.
  if (mobile) await page.goBack();
  const again = page.locator('.orch .msg-assistant', { hasText: `Echo: A worker has started on ${wid}` }).filter({ hasText: tag }).locator('a.id-link');
  await again.nth(0).click();
  await expect(page).toHaveURL(new RegExp(`#/dispatcher/${wid}$`));
  await expect(page.locator('.dispatcher-panel').getByTestId(`work-${wid}`)).toBeVisible();
  await shot('3-request-panel');

  if (mobile) await page.goBack();
  await again.nth(3).click();
  await expect(page).toHaveURL(new RegExp(`#/machine/${machine}/sandbox/${sandbox}$`));
  await expect(page.getByTestId('machine-sandbox-panel')).toBeVisible();
  await shot('4-sandbox-panel');
});
