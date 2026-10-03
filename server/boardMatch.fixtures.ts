// Paraphrase pairs and near-misses for board_check matching (server/boardMatch.test.ts). The real ones are players'
// titles and reports from #bug-reports, as FFBox's pull requests on FinalFactory quote them (#694, #756, #764, #778,
// #779, #798, #804, #806, #808); the teapot pair is w217's test entry.

/** A ledger entry: its title and the start of its brief. */
export interface FixtureEntry {
  id: string;
  title: string;
  brief?: string;
}

/** The ledger the fixtures search: the matches, the near-misses' neighbours, and ordinary requests around them. */
export const LEDGER: FixtureEntry[] = [
  { id: 'w217', title: 'TEST ENTRY, please ignore: purple teapot appears in the cargo hold' },
  { id: 'w301', title: 'Alt Tabbing still breaks movement in singleplayer', brief: 'Steam Deck, Game Mode. Every alt-tab in fullscreen kills movement until a restart.' },
  { id: 'w302', title: 'When submitting a big report you can move the bug reporter window', brief: 'At the main menu, dragging the bug reporter makes it stop responding to clicks; only Escape closes it.' },
  { id: 'w303', title: 'Desync camps at heartbeat 8 after a join (0.50.0.51)', brief: 'Fixes the camps desync 8 heartbeats after a join or recovery (forks 2-8, 2-16, 2-24).' },
  { id: 'w304', title: 'enemies stacked on one spot' },
  { id: 'w310', title: 'Alt view icons are too big on the map' },
  { id: 'w311', title: 'Cargo hold UI shows the wrong item count after unloading' },
  { id: 'w312', title: 'Enemies never attack my base' },
  { id: 'w313', title: 'Desync movers at heartbeat 512 after building a belt' },
  { id: 'w314', title: 'Bug reporter crashes when attaching a large save' },
  { id: 'w315', title: 'Belts stop after loading a save' },
  { id: 'w316', title: 'Power loop warning text is confusing' },
  { id: 'w317', title: 'Map icon sizes wrong at max zoom' },
  { id: 'w318', title: 'Mass driver projectiles disappear mid-flight' },
  { id: 'w319', title: 'Research tree scrolls back to the top after each unlock' },
  { id: 'w320', title: 'Station riders hidden while docked' },
  { id: 'w321', title: 'Multiplayer client cannot rejoin after host saves' },
  { id: 'w322', title: 'Crash when opening the trade window' },
];

/** A report and the ledger entry it repeats, in other words. */
export const SHOULD_MATCH: { report: string; id: string; why: string }[] = [
  { report: 'I see a purple teapot in my cargo', id: 'w217', why: 'w217: the teapot test' },
  { report: 'Singleplayer alt tabbing breaks movement entirely', id: 'w301', why: '#764: the second alt-tab thread' },
  { report: 'This save has the alt tab breaking movement bug', id: 'w301', why: '#764: the third alt-tab thread' },
  { report: "Sometimes I couldn't move after tabbing back in", id: 'w301', why: '#694: the first alt-tab report' },
  { report: 'Multipli Enemies are on one spot looks invincible', id: 'w304', why: '#798: Discord, enemies on one spot' },
  { report: 'Desync camps+census at heartbeat 8 (0.50.0.51, WindowsPlayer)', id: 'w303', why: '#806: the same post-reset desync' },
  { report: 'Desync camps at heartbeat 8 (0.50.0.51, OSXPlayer), forked twice', id: 'w303', why: '#808: the same post-reset desync' },
  { report: 'Dragging the bug reporter window at the main menu stops it responding to clicks', id: 'w302', why: '#779: the same thread as #778' },
];

/** A report that must not match the entry beside it: another bug in the same system. */
export const MUST_NOT_MATCH: { report: string; id: string; why: string }[] = [
  { report: 'The cargo hold UI shows the wrong count', id: 'w217', why: 'cargo, but not the teapot' },
  { report: 'Alt view icons are huge', id: 'w301', why: 'Alt, but not alt-tab' },
  { report: 'Enemies never attack my base', id: 'w304', why: 'enemies, but not stacked' },
  { report: 'Desync movers at heartbeat 512 after building a belt', id: 'w303', why: 'a desync, another surface and heartbeat' },
  { report: 'Bug reporter crashes when attaching a large save', id: 'w302', why: 'the bug reporter, but a crash' },
  { report: 'Movement is too slow in multiplayer', id: 'w301', why: 'movement, but not alt-tab' },
  { report: 'Belts stop after loading a save', id: 'w303', why: 'nothing to do with it' },
  { report: 'movement broken', id: 'w301', why: 'too vague to call it alt-tab: maybe at most' },
];
