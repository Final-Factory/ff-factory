// Meaning-aware matching for board_check (docs/intake.md, "the ledger check"): does a report FFBox is about to work
// repeat a request already in the ledger, even when the words differ ("I see a purple teapot in my cargo" against
// "purple teapot appears in the cargo hold")?
//
// DETERMINISTIC AND LOCAL, ON PURPOSE. The report's text is a player's, so it is untrusted: here it is only ever split
// into words and compared, never handed to a model, so nothing written in it can steer the answer. It costs nothing,
// needs no network, and answers in well under a millisecond per candidate, inside FFBox's 5 s window with room to spare.
//
// How a text becomes concepts: lower case, accents off; multi-word phrases the game's players use are folded into one
// concept ("alt tab", "tabbing back in" -> alttab; "one spot", "stacked" -> stack; "cargo hold" -> cargo); every word
// is stemmed lightly ("tabbing" -> tab, "enemies" -> enemy) and mapped through a small synonym table ("invulnerable",
// "unkillable" -> invincible); "heartbeat 8" keeps its number (hb8), the one number that tells desyncs apart. Words
// that say nothing about which bug it is (bug, game, please, test, ignore, ...) are dropped.
//
// How two texts are scored: each concept weighs its rarity in the ledger being searched (inverse document frequency),
// so a shared "teapot" counts for far more than a shared "desync". The score is the mean of the weighted cosine and
// the weighted coverage of the shorter text, from 0 to 1. Two concepts within one typo of each other (multipli,
// multiple) count as the same.

/** Words that say nothing about which bug it is. */
const STOP = new Set(
  (
    'the and for with from into that this then than when what which while please make sure also some need needs should would could ' +
    'about after before over under using use via our its all any can get set new add now let just more most onto them they their ' +
    'there here your you not but are was were has have had been being does done doing will i me my mine we us it is be to of in on ' +
    'at by an a or so if as up out do did dont don cant couldnt wont isnt doesnt didnt im ive ok okay yes no hi hello hey thanks thank ' +
    'bug bugs issue issues problem problems game report reported reporting seem seems seemed look looks looked see saw seen ' +
    'appear appears appeared happen happens happened sometimes still again always just really very anyone someone something ' +
    'test entry ignore ffbox please couldn didn doesn isn wasn won don can aren haven entire entirely completely totally ' +
    'windowsplayer osxplayer linuxplayer windows mac macos linux steam ' +
    // What the request asks someone to do, not which bug it is (w343: "Please diagnose this" matched every report).
    'diagnose diagnosis diagnos diagnosi investigate investigation investigat'
  ).split(' '),
);

/** Phrases folded into one concept before the words are split. Order matters: the longer phrase first. */
const PHRASES: [RegExp, string][] = [
  [/\balt\s*[-+]?\s*tab(?:bing|bed|s)?\b/g, ' alttab '],
  [/\btab(?:bing|bed)?\s+(?:back\s+in|back|out|in\s+and\s+out)\b/g, ' alttab '],
  [/\b(?:lose|lost|losing|regain(?:ed|ing)?)\s+focus\b/g, ' alttab '],
  [/\b(?:one|same|single|a)\s+(?:spot|place|point|location|tile)\b/g, ' stack '],
  [/\bon\s+top\s+of\s+each\s+other\b/g, ' stack '],
  [/\bcargo\s+(?:hold|bay|space)\b/g, ' cargo '],
  [/\bout\s+of\s+sync\b/g, ' desync '],
  [/\bco\s*-?\s*op\b/g, ' multiplayer '],
  [/\bsingle\s*-?\s*player\b/g, ' singleplayer '],
  [/\bmulti\s*-?\s*player\b/g, ' multiplayer '],
  [/\bcan\s*'?\s*no?t\s+(?:be\s+)?(?:kill(?:ed)?|destroy(?:ed)?|damage[d]?)\b/g, ' invincible '],
  [/\bwon\s*'?\s*t\s+die\b/g, ' invincible '],
  [/\bnothing\s+(?:can\s+)?kills?\b/g, ' invincible '],
  [/\bcan\s*'?\s*no?t\s+move\b/g, ' move stuck '],
  [/\bheart\s*beat\s*#?\s*(\d{1,7})\b/g, ' hb$1 '],
  [/\bhb\s*#?\s*(\d{1,7})\b/g, ' hb$1 '],
];

/** A stem (after stem()) to its concept. Kept small and about the game: a missing synonym costs a weaker match, never a wrong one. */
const SYNONYMS: Record<string, string> = {
  enemi: 'enemy', enemy: 'enemy', hostil: 'enemy', pirat: 'enemy', mob: 'enemy', drone: 'enemy',
  invinc: 'invincible', invincibl: 'invincible', invulner: 'invincible', invulnerabl: 'invincible', immort: 'invincible', immortal: 'invincible', unkil: 'invincible', unkillabl: 'invincible', godmod: 'invincible',
  stack: 'stack', pile: 'stack', pil: 'stack', clump: 'stack', clust: 'stack', cluster: 'stack', overlap: 'stack', bunch: 'stack',
  multipl: 'many', multipli: 'many', mani: 'many', many: 'many', lot: 'many', sever: 'many', several: 'many', multi: 'many',
  freez: 'stuck', freeze: 'stuck', froze: 'stuck', frozen: 'stuck', stuck: 'stuck', lock: 'stuck', hang: 'stuck', hung: 'stuck',
  move: 'move', mov: 'move', movement: 'move', walk: 'move', wasd: 'move', run: 'move',
  break: 'break', broke: 'break', broken: 'break', stop: 'break', fail: 'break',
  crash: 'crash', ctd: 'crash', exception: 'crash',
  desync: 'desync', desynch: 'desync', sync: 'desync',
  join: 'join', connect: 'join', reconnect: 'join', rejoin: 'join', recoveri: 'join', recover: 'join',
  window: 'window', panel: 'window', dialog: 'window', popup: 'window',
  drag: 'drag', dragg: 'drag',
  click: 'click', clickabl: 'click', respond: 'click', unrespons: 'click', unclickabl: 'click',
  cargo: 'cargo', inventori: 'inventory', inventory: 'inventory',
  teapot: 'teapot', kettl: 'teapot',
  belt: 'belt', conveyor: 'belt', conveyer: 'belt',
  ship: 'ship', vessel: 'ship', spaceship: 'ship',
  save: 'save', load: 'load', reload: 'load',
  purpl: 'purple', violet: 'purple',
  reporter: 'reporter',
  camp: 'camp', mover: 'mover', census: 'census', vision: 'vision',
};

/**
 * Concepts that say what went wrong, not which bug it is: a report that shares only these and one more with a request
 * may be the same bug, never surely (band).
 */
const GENERIC = new Set(['break', 'stuck', 'crash', 'click', 'window', 'many', 'save', 'load', 'work', 'fix', 'wrong', 'error', 'slow', 'lag']);

/** A light English stemmer: enough to make "tabbing", "tabs" and "tab" one word, and "enemies" "enemi". */
export function stem(w: string): string {
  if (w.length <= 3) return w;
  let s = w;
  for (const [suffix, repl] of [
    ['ies', 'i'],
    ['ied', 'i'],
    ['ing', ''],
    ['edly', ''],
    ['ed', ''],
    ['ly', ''],
    ['es', ''],
    ['s', ''],
    ['e', ''],
  ] as const) {
    if (s.endsWith(suffix) && s.length - suffix.length >= 3) {
      s = s.slice(0, s.length - suffix.length) + repl;
      break;
    }
  }
  // A doubled last consonant after a suffix came off: "tabb" -> "tab", "dragg" -> "drag", "stopp" -> "stop".
  if (s.length >= 4 && s.at(-1) === s.at(-2) && !'aeiouls'.includes(s.at(-1)!)) s = s.slice(0, -1);
  return s;
}

/** The concepts of a text: what is compared. */
export function concepts(text: string): string[] {
  let t = ` ${text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()} `;
  t = t.replace(/[’'`]/g, "'");
  for (const [rx, to] of PHRASES) t = t.replace(rx, to);
  const out: string[] = [];
  for (const raw of t.split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || STOP.has(raw)) continue;
    if (/^hb\d+$/.test(raw)) {
      out.push(raw);
      continue;
    }
    if (/^\d+$/.test(raw) || raw.length < 3) continue;
    const s = stem(raw);
    if (STOP.has(s)) continue;
    out.push(SYNONYMS[s] ?? SYNONYMS[raw] ?? s);
  }
  return out;
}

const editWithin1 = (a: string, b: string) => {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
};

/** The same concept, allowing one typo in a word of five letters or more ("multipli" for "multiple"). */
const same = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && !a.startsWith('hb') && editWithin1(a, b));

/** A ledger to search: each document's concepts, and how many documents hold each concept. */
export interface MatchIndex {
  docs: number;
  df: Map<string, number>;
}

export function indexOf(texts: readonly string[][]): MatchIndex {
  const df = new Map<string, number>();
  for (const t of texts) for (const c of new Set(t)) df.set(c, (df.get(c) ?? 0) + 1);
  return { docs: texts.length, df };
}

/** How much a concept says: rare across the ledger is a lot, everywhere is little. Smoothed, so a tiny ledger still ranks. */
// A concept the ledger does not hold at all weighs as one it holds once: it cannot be shared, so weighing it as the
// rarest thing there is would only punish a report for its extra words.
const weight = (c: string, ix: MatchIndex) => Math.log((ix.docs + 2) / (Math.max(1, ix.df.get(c) ?? 0) + 1)) + 0.5;

export interface TextMatch {
  /** 0 to 1. */
  score: number;
  /** The concepts both texts share, strongest first: what a person reads to see why. */
  shared: string[];
  /**
   * Whether one shared concept is distinctive: held by few entries of the ledger (distinctiveDf). Without one, two
   * texts that share only common words ("movement broken" and an alt-tab report) are never the same bug for sure.
   */
  distinctive: boolean;
  /** How many shared concepts say which bug it is (not GENERIC). */
  core: number;
}

/** How many ledger entries may hold a concept for it to still say which bug this is: 3% of the ledger, at least one. */
export const distinctiveDf = (ix: MatchIndex) => Math.max(1, Math.round(ix.docs * 0.03));

/** A text's concepts once each, near-duplicates (one typo apart) folded into the first. */
function distinct(xs: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of new Set(xs)) if (!out.some((d) => same(c, d))) out.push(c);
  return out;
}

/** How alike two texts' concepts are, weighted by `ix`. */
export function similarity(a: readonly string[], b: readonly string[], ix: MatchIndex): TextMatch {
  // Concepts within one typo of each other are one concept ("diagnos" and "diagnosi"), and each concept of one text
  // pairs with at most one of the other's: two report words once both matched a request's one title word, counted as
  // two shared concepts with coverage above 1, and scored 1 (w343).
  const A = distinct(a);
  const B = distinct(b);
  if (!A.length || !B.length) return { score: 0, shared: [], distinctive: false, core: 0 };
  const wa = A.reduce((n, c) => n + weight(c, ix), 0);
  const wb = B.reduce((n, c) => n + weight(c, ix), 0);
  const shared: { c: string; w: number }[] = [];
  const used = new Set<number>();
  for (const c of A) {
    const i = B.findIndex((d, j) => !used.has(j) && same(c, d));
    if (i < 0) continue;
    used.add(i);
    shared.push({ c, w: Math.min(weight(c, ix), weight(B[i], ix)) });
  }
  const s = shared.reduce((n, x) => n + x.w, 0);
  const cos = s / Math.sqrt(wa * wb);
  const cover = Math.min(1, s / Math.min(wa, wb));
  // One shared concept says little whatever its weight: a lone shared word ("cargo") is capped below any useful band.
  const score = shared.length < 2 ? Math.min(0.45, (cos + cover) / 2) : (cos + cover) / 2;
  const dmax = distinctiveDf(ix);
  const distinctive = shared.some((x) => !GENERIC.has(x.c) && (ix.df.get(x.c) ?? 0) <= dmax);
  const core = shared.filter((x) => !GENERIC.has(x.c)).length;
  return { score: Math.round(Math.min(1, score) * 100) / 100, shared: shared.sort((x, y) => y.w - x.w).map((x) => x.c), distinctive, core };
}

/** The bands a board_check answers by: at or above `high` the ledger has it; at or above `medium` it may. */
export interface MatchThresholds {
  high: number;
  medium: number;
}

/** Set from the fixtures (server/boardMatch.fixtures.ts): every paraphrase pair scored 0.72 or more, every near-miss 0.39 or less. */
export const DEFAULT_THRESHOLDS: MatchThresholds = { high: 0.7, medium: 0.45 };

/**
 * Which band a match falls in. High needs, besides the score, a distinctive shared concept and two shared concepts that
 * say which bug it is ("movement broken" shares one with an alt-tab report: maybe at most).
 */
export function band(m: TextMatch, t: MatchThresholds): 'high' | 'medium' | 'low' {
  if (m.score >= t.high && m.distinctive && m.core >= 2) return 'high';
  return m.score >= t.medium ? 'medium' : 'low';
}

/** Thresholds from config, sane whatever was written: each 0..1, medium never above high. */
export function thresholdsOf(cfg: Partial<MatchThresholds> | undefined): MatchThresholds {
  const n = (v: unknown, d: number) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : d);
  const high = n(cfg?.high, DEFAULT_THRESHOLDS.high);
  return { high, medium: Math.min(high, n(cfg?.medium, DEFAULT_THRESHOLDS.medium)) };
}

/** A report against one ledger entry: the better of its title alone and its title with the start of its brief. */
export function entryMatch(report: readonly string[], title: readonly string[], full: readonly string[], ix: MatchIndex): TextMatch {
  const a = similarity(report, title, ix);
  const b = similarity(report, full, ix);
  return a.score >= b.score ? a : b;
}
