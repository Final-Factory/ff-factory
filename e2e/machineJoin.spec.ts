import { expect, openSidebar, test } from './fixtures.ts';

// The dashboard's Add a machine with a join code (w1592, web/src/components/MachinePanel.tsx JoinMachineModal; lothsahn:
// "Can it be an installer I download from the website instead of opening a ssh tunnel?"). The two join routes are answered
// here (their server side is server/machineJoinHttp.test.ts and machines.test.ts createJoin), so no machine record lands
// in the server every other spec's sidebar shows.

// The route mocks must reach the page itself, not a service worker (as e2e/attachments.spec.ts).
test.use({ serviceWorkers: 'block' });

const CODE = 'ABCDE-FGHJK-MNPQR-STVWX';
const INSTALLER = `@echo off\r\nset "FF_JOIN_CODE=${CODE}"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm 'https://fff.example.ts.net/join/windows.ps1' | iex"\r\n`;

test('add a machine: opened on the new PC, the form names it after its tailnet device; the answer shows the code once and downloads the installer with it', async ({ authed: page, browserName }) => {
  const asked: unknown[] = [];
  await page.route('**/api/machines/join/device', (r) => r.fulfill({ json: { name: 'desktop-coosego' } }));
  await page.route('**/api/machines/join', async (r) => {
    asked.push(r.request().postDataJSON());
    await r.fulfill({
      json: {
        machine: { id: 'desktop-coosego', name: 'desktop-coosego', host: 'desktop-coosego', status: 'deploying', purpose: '', portalUrl: 'https://fff.example.ts.net', sandboxes: [] },
        code: CODE,
        last4: 'TVWX',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        tailnetName: 'desktop-coosego',
        limits: { maxUnity: 2 },
        portalUrl: 'https://fff.example.ts.net',
        page: 'https://fff.example.ts.net/join',
        windowsCommand: 'irm https://fff.example.ts.net/join/windows.ps1 | iex',
        unixCommand: 'bash -c "$(curl -fsSL https://fff.example.ts.net/join/unix.sh)"',
        installer: { name: 'ff-factory-join.cmd', text: INSTALLER },
      },
    });
  });
  const sidebar = await openSidebar(page);
  await sidebar.locator('.fl-add-machine').click();
  const modal = page.locator('.modal');
  await expect(modal.getByText('A Windows PC, Mac or Linux PC on the tailnet joins by itself')).toBeVisible();
  await expect(modal.getByLabel('Id')).toHaveValue('desktop-coosego');
  await expect(modal.getByLabel('Its tailnet device name')).toHaveValue('desktop-coosego');
  await modal.getByLabel('Unity editors at once').fill('9');
  await expect(modal.getByRole('button', { name: 'Make the installer' })).toBeDisabled();
  await modal.getByLabel('Unity editors at once').fill('2');
  await modal.getByRole('button', { name: 'Make the installer' }).click();

  const made = page.getByTestId('join-made');
  await expect(made.getByText(CODE)).toBeVisible();
  await expect(made.getByText('This is the only time it is shown')).toBeVisible();
  expect(asked).toEqual([{ id: 'desktop-coosego', tailnetName: 'desktop-coosego', maxUnity: 2 }]);
  if (browserName === 'chromium') {
    const [download] = await Promise.all([page.waitForEvent('download'), made.getByRole('button', { name: 'Download the Windows installer' }).click()]);
    expect(download.suggestedFilename()).toBe('ff-factory-join.cmd');
    const path = await download.path();
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(path, 'utf8')).toBe(INSTALLER);
  }
  await expect(made.getByText('irm https://fff.example.ts.net/join/windows.ps1 | iex')).toBeVisible();

  // The ssh form is one click away, and back. (Closed, not Done: Done opens the machine's page, which only the mock knows.)
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await sidebar.locator('.fl-add-machine').click();
  await modal.getByRole('button', { name: 'Set one up over ssh from this host instead' }).click();
  await expect(modal.getByLabel('ssh host')).toBeVisible();
  await modal.getByRole('button', { name: 'Add it with an installer run on the PC instead' }).click();
  await expect(modal.getByLabel('Its tailnet device name')).toBeVisible();
});
