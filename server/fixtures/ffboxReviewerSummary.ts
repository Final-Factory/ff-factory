// A test turn (w3622): FFBox's w3596 summary (conversation 1325) as ffbox's scripts/intake/diagnose.md asks for it since
// ffbox 86a54df: a plain `root cause:` line, then after the signature `Fix:` and `**Risk:**` lines for the reviewer, then
// the evidence with its code names. Written for the test from FFBox's real summary, not FFBox's own words.
export const FFBOX_REVIEWER_SUMMARY = [
  '# hang 20261025T073811Z-hang-25862e0e5a',
  '',
  'root cause: the game set the same screen size a second time at launch, and on Linux with the Steam overlay that second setup froze the game on its first frame.',
  'hang signature: libc.so.6!syscall / UnityPlayer.so!GfxDeviceClient::WaitForPendingPresent',
  'Fix: the game no longer re-applies the screen size at launch when the window already has it, so a Linux player with the Steam overlay gets past the first frame.',
  '**Risk:** Low for other players: it only skips a call when nothing would change, and the 2 tests that fail on this branch fail on master too. Whether it ends this player’s freeze is unproven, since the freeze could not be made to happen here.',
  '',
  '**What the report shows**',
  '',
  '- **Main thread:** blocked (cpu 0 ms, in futex) in `GfxDeviceClient::WaitForPendingPresent`.',
  '',
  '**What I can\'t prove here.** I could not make the freeze happen here, because this machine has no Steam overlay. In both of the player’s sessions the logs show the game drawing after the first screen setup and stopping on its first frame after the second. (Code: presents hung on the first present after the second swapchain.)',
  '',
  '**What I changed** (two commits):',
  '- **Fix:** `Apply` now skips `Screen.SetResolution` when the window already is what it would ask for.',
  '- **Tests:** `Tests.UI.DisplayLaunchApplyTests`.',
  '',
  '**Verification:**',
  '- Full EditMode suite (`ffverify`): compiled, 16349/16361 passed, 2 failed: `Tests.Net.LanDiscoveryTests` twice, which fail the same way on master.',
].join('\n');
