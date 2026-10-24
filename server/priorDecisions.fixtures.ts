import { readFileSync } from 'node:fs';

// w1958's notes as the ledger holds them (2026-10-24), and an excerpt of game PR #2395's diff (fixtures/w2085-pr2395.diff:
// the English table row, Messages.cs and docs/HowToPlay.md hunks, as `gh pr diff 2395` printed them).
export const W1958_0459 =
  'Ben\'s answers, verbatim, 2026-10-24:\n1. Map drag box (PR #2371): "Yes, merge the map drag box as it looks." Merge on green.\n' +
  '3. Singularity stations stop (thread 1256): "Works as designed: FFBox explains the circuits to the player." No game change.\n' +
  '4. Low-ore right-click (thread 1251): "Right-click dismisses for a while; shift+right-click silences for good." Change w1514\'s behaviour: right-click dismisses the warning for a while (decide by research how long), Shift+right-click silences that asteroid for good, and the Mining Station switch still turns it back on.\n' +
  '5. Waiting Blueprint Projector (thread 1255): "maybe make the blueprint yellow or something when its waiting so theres a visual indication".';
export const W1958_1550 = 'Ben\'s answers: 1) "Yes, merge the yellow waiting hologram as it looks." 2) "No, leave it at the fix and the manual file edit."';
/** What worker d57b4ea5 raised at 16:32 (its [needs you] line in w1958's log). */
export const W1958_1632 = "Look at the low-ore alert's tooltip before and after, and say whether it can merge as it looks (#2395)";
export const PR2395_DIFF = readFileSync(new URL('./fixtures/w2085-pr2395.diff', import.meta.url), 'utf8');

