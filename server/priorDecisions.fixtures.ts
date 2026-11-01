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


// w2651's note as the ledger holds it (Ben, 2026-10-31 20:51 UTC), and the three questions worker 8fe9af40 put to him at
// 2026-11-01 04:57 UTC (its waiting_on_person call, the stills left out), each with its answers, the recommended one first.
export const W2651_2051 =
  'Ben\'s answer, his words: "Build D, the right rail: a column on the right that never moves." Build D for real as one merged inventory window, behind a feature toggle. ' +
  'Fix the costs your report named: move the hover card to the left of the rail, and make Crafting stop above Station Info instead of hiding it. ' +
  'Station Info is being rebuilt as the Tiles design (w2580), so check the rail against that layout too. Move no other panel. ' +
  'Bring Ben stills and a clip from a built game (desktop and Deck), with a fresh critic, for his OK before merging.';
export const W2651_0457 = [
  {
    question:
      'The right rail in a built game, before left and after right. A fresh critic found nothing broken or ugly. May it merge behind its toggle (off for players), with the HUD pin rules updated so the hover card stands left of the rail and the rail is the Player Inventory?\n\n![Crafting at 1920x1080](/srv/fff/review/w2651/pair-1-craft-1920.png)\n![The hover card left of the rail](/srv/fff/review/w2651/pair-3-hover-1920.png)',
    options: [
      { label: 'Yes, merge it behind the toggle and update the pin rules to match.', description: 'I change the pin rules quoting you, then merge on green CI.', recommended: true },
      { label: "Not yet: change something first (I'll say what).", description: 'I rebuild and bring new stills and clips.' },
      { label: 'No, drop the right rail.', description: 'I close the PR.' },
    ],
  },
  {
    question: "At the Deck's 1280x800 size the rail goes wide (9 to 11 slot columns) so every slot shows with no scrolling, reaching about mid-screen. Keep it wide, or make it a narrow column that scrolls?",
    options: [
      { label: 'Keep it wide so the whole inventory shows without scrolling.', description: 'As built.', recommended: true },
      { label: 'Make it a narrow column of 6 that scrolls on small screens.', description: 'Less of the world covered.' },
    ],
  },
  {
    question: 'At 1280x800 at UI scale 0.9 Crafting stops above Station Info, showing three whole recipes and scrolling to the rest. Keep that, or let Crafting stand full height over Station Info?',
    options: [
      { label: 'Keep it: Crafting scrolls and Station Info stays visible.', description: 'As built.', recommended: true },
      { label: 'Let Crafting stand full height over Station Info at that size.', description: 'Station Info hidden while Crafting is open.' },
    ],
  },
];
