// w6189: does the game player at a commit read FF_GAME_DATA_DIR? A pair run of a pre-1.0 (0.50) player was treated as a
// player that writes the owner's own data folder (WorkPair.legacyData, w5965/w6003), so its legs went only where a sandbox
// agent measured Medium integrity, and none did. Game PR #4357 (merge 6fcc274a, on pre-1.0 2026-11-26) backports
// FF_GAME_DATA_DIR to that line, and w6122 ran 5 of 5 MP scenarios of such a player at Low integrity on lothdesktop; the
// gate still refused w6187's pair check of PR #4382 (head 20786882d8, which carries #4357).
//
// The check reads the file that decides where the player writes, at the commit the legs run, rather than asking whether
// #4357's merge is an ancestor: a branch that cherry-picked the backport, or a PR branch cut from #4357's own head before it
// merged, carries the behaviour without that merge commit, and an ancestry test would refuse it; the file says what the
// build does. It fails closed: a commit GitHub does not know, a fetch that fails or a file that does not parse as the
// backport keeps the refusal, with a reason that says which.
import type { Runner } from './githubTokens.ts';

export const GAME_DATA_PATHS = 'Assets/Scripts/FFCore/GameData/GameDataPaths.cs';

/** reads: the player at `commit` (the full sha) reads FF_GAME_DATA_DIR. Otherwise why not, and whether it was checked at all. */
export type DataDirVerdict = { reads: true; commit: string } | { reads: false; checked: boolean; why: string };

/**
 * The backport as GameDataPaths.cs carries it (pre-1.0 line 33: `public const string RootVariable = "FF_GAME_DATA_DIR";`,
 * read through Environment.GetEnvironmentVariable): the name as a C# string literal and an environment read. A comment that
 * only mentions the variable is not enough.
 */
export const readsDataDirSource = (src: string): boolean => /"FF_GAME_DATA_DIR"/.test(src) && /\bGetEnvironmentVariable\s*\(/.test(src);

const cache = new Map<string, DataDirVerdict>();
/** Tests only: forget what was read. */
export const forgetDataDirChecks = (): void => cache.clear();

const tail = (r: { stdout: string; stderr: string; code: number }) => (r.stderr || r.stdout).trim().replace(/\s+/g, ' ').slice(-200) || `gh exited ${r.code}`;

/**
 * The full sha GitHub resolves `commit` (7 to 40 hex) to in `repo`: missing when GitHub answers that no such commit exists
 * (HTTP 422 "No commit found"; an ambiguous short sha answers so too), else the read's error. A 404 is the repo the token
 * cannot see (w6289's review measured both), not a missing commit, so it is an error: it must not refuse every pair run.
 */
async function shaOf(gh: Runner, repo: string, commit: string): Promise<{ full: string } | { missing: true } | { missing: false; error: string }> {
  const c = await gh('gh', ['api', `repos/${repo}/commits/${commit}`, '--jq', '.sha'], { timeoutMs: 30_000 });
  const full = c.stdout.trim().toLowerCase();
  if (c.code === 0 && /^[0-9a-f]{40}$/.test(full) && full.startsWith(commit.toLowerCase())) return { full };
  if (/HTTP 422|No commit found/i.test(c.stderr + c.stdout)) return { missing: true };
  return { missing: false, error: c.code === 0 ? `GitHub answered "${clip(full, 60)}" for it` : tail(c) };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Read GameDataPaths.cs at `commit` in `repo` through GitHub (gh api). A settled answer is kept per full sha. */
export async function gameDataDirAt(gh: Runner, repo: string, commit: string): Promise<DataDirVerdict> {
  const short = commit.slice(0, 10);
  const no = (why: string, checked = false): DataDirVerdict => ({ reads: false, checked, why });
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return no(`"${short}" is not a commit, so FF Factory could not check it for the FF_GAME_DATA_DIR backport (w6189)`);
  const hit = commit.length === 40 ? cache.get(commit.toLowerCase()) : undefined;
  if (hit) return hit;
  const c = await shaOf(gh, repo, commit);
  if (!('full' in c)) {
    return no(c.missing
      ? `GitHub knows no commit ${short} in ${repo}, so FF Factory could not check it for the FF_GAME_DATA_DIR backport (w6189)`
      : `FF Factory could not read commit ${short} from GitHub to check it for the FF_GAME_DATA_DIR backport (${c.error}; w6189)`);
  }
  const full = c.full;
  const known = cache.get(full);
  if (known) return known;
  const at = full.slice(0, 10);
  const f = await gh('gh', ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${GAME_DATA_PATHS}?ref=${full}`], { timeoutMs: 30_000 });
  let v: DataDirVerdict;
  if (f.code !== 0) {
    if (!/HTTP 404|Not Found/i.test(f.stderr + f.stdout)) return no(`FF Factory could not read ${GAME_DATA_PATHS} at ${at} from GitHub to check it for the FF_GAME_DATA_DIR backport (${tail(f)}; w6189)`);
    v = no(`${at} has no ${GAME_DATA_PATHS}, so its player does not read FF_GAME_DATA_DIR (w6189)`, true);
  } else {
    v = readsDataDirSource(f.stdout) ? { reads: true, commit: full } : no(`${GAME_DATA_PATHS} at ${at} does not read FF_GAME_DATA_DIR: it predates the backport (game PR #4357; w6189)`, true);
  }
  cache.set(full, v);
  return v;
}

/**
 * The commits a check read (DataDirVerdict, plus every other player commit a pair run names: PairDataDirVerdict.commits).
 * w6680: a pair run's verdict covers each commit in it, the pair's own first.
 */
export type PairDataDirVerdict = { reads: true; commit: string; commits: string[] } | { reads: false; checked: boolean; why: string };

/** What a pair run says once its commit (and, w6680, every other player commit it names) was found to read FF_GAME_DATA_DIR (WorkPair.dataDirChecked). */
export const dataDirClearedText = (commit: string, others: readonly string[] = []): string => {
  const rest = others.filter((o) => !covers([commit], o));
  return rest.length
    ? `its players at ${[commit, ...rest].map((c) => c.slice(0, 10)).join(' and ')} all read FF_GAME_DATA_DIR (${GAME_DATA_PATHS}, the backport of game PR #4357, read at each commit; w6680), so it is not a pre-w5297 run and its legs may go where sandbox agents measure Low (w6189)`
    : `its player at ${commit.slice(0, 10)} reads FF_GAME_DATA_DIR (${GAME_DATA_PATHS}, the backport of game PR #4357), so it is not a pre-w5297 player and its legs may go where sandbox agents measure Low (w6189)`;
};

/** A sha as otherPlayerIn reads one: a hex word of 7 to 40 characters with a digit in it. */
const SHA_WORD = /\b[0-9a-f]{7,40}\b/gi;
const isSha = (h: string) => /\d/.test(h);
const covers = (checked: readonly string[], h: string) => {
  const x = h.toLowerCase();
  return checked.some((c0) => { const c = c0.toLowerCase(); return x.startsWith(c) || c.startsWith(x); });
};

/**
 * w6680: a 0.50.x.y version written in parentheses right after a sha that was read, "dc4643b4c2 (0.50.0.120)", is that
 * commit's version, not another build: w6678's legacy_data said "run A is a pre-1.0 player at dc4643b4c2 (0.50.0.120)".
 * Only that shape; "ac80d7b0 is 0.50.0.47" or "Steam 0.50.0.47" still name a build no commit is. w6686 (w6682's review of
 * PR #1543): the bracket must close right after the version, so "dc4643b4c2 (0.50.0.47 installed)" names a build; and a
 * published, installed, Steam, release or shipped word up to two words before the sha ("the published dc4643b4c2
 * (0.50.0.47)") makes it a build too, as do downloaded, live, retail and public (w6688). At most three spaces sit around the
 * "(" (w6688: a 120-character window with an open gap would have excused a sha 100 spaces away, which #1543 did not). `at` and `end` bound the version (VERSION_WORD, a leading "v" included).
 */
const versionOfChecked = (said: string, at: number, end: number, checked: readonly string[]): boolean => {
  if (!/^\s*\)/.test(said.slice(end, end + 20))) return false;
  const before = said.slice(Math.max(0, at - 120), at);
  const m = /\b([0-9a-f]{7,40})\s{0,3}\(\s{0,3}$/i.exec(before);
  if (!m || !isSha(m[1]) || !covers(checked, m[1])) return false;
  return !INSTALLED_WORD_BEFORE.test(before.slice(0, m.index));
};
/** w6686: a word that makes the sha after it a build players run, with at most two words between them. */
const INSTALLED_WORD_BEFORE = /\b(?:published|installed|downloaded|steam|releases?|released|shipped|live|retail|public)\b\W*(?:[\w.-]+\W+){0,2}$/i;
/**
 * A 0.50.x.y version as otherPlayerIn reads one. w6686: a leading "v" counts ("v0.50.0.47"); before it, `\b0\.50` could not
 * match after the "v", so such a version was no version at all.
 */
const VERSION_WORD = /(?:\bv|\b)0\.50\.\d+\.\d+\b/gi;

/**
 * w6235 (w6192's review of PR #1402): the check reads only the pair's `commit`, but a pair run can run more than one player
 * (pairCommitsOf), and a worker's legacy_data may be about another one: "the host runs the Steam pre-1.0 0.50.0.47 build"
 * while `commit` is the PR head checked against it. Such words keep the mark. A sha is a hex word of 7 to 40 characters with
 * a digit in it (so English words such as "acceded" are none); one that is `commit` (either a prefix of the other) is the
 * checked player. w6680: `checked` lists every commit that was read (pairDataDirAt reads each sha the run names); a sha in
 * it is a checked player too. Any 0.50.x.y version is a build, not a commit, so nothing here checked it, except one written
 * as a checked sha's version (versionOfChecked). Answers why, or undefined.
 */
export function otherPlayerIn(said: string, commit: string, where = 'legacy_data', checked: readonly string[] = [commit]): string | undefined {
  const c = commit.toLowerCase();
  const read = checked.length ? checked : [commit];
  const sha = (said.match(SHA_WORD) ?? []).find((h) => isSha(h) && !covers(read, h) && !(h.toLowerCase().startsWith(c) || c.startsWith(h.toLowerCase())));
  const version = [...said.matchAll(VERSION_WORD)].find((m) => !versionOfChecked(said, m.index, m.index + m[0].length, read))?.[0];
  const installed = sha || version ? undefined : installedBuildIn(said);
  if (!sha && !version && !installed) return undefined;
  const named = sha ? `commit ${sha.slice(0, 10)}` : version ? `build ${version}` : `a build no commit is ("${clip(installed!.replace(/\s+/g, ' '), 60)}")`;
  const which = read.length > 1 ? read.map((x) => x.slice(0, 10)).join(' and ') : c.slice(0, 10);
  return `its ${where} names ${named}, but FF Factory checked only ${which} for the FF_GAME_DATA_DIR backport, so the mark stays (w6235)`;
}

/**
 * w6680: every player commit a pair run names, the pair's own `commit` first: each sha in its legacy_data, what and brief
 * (the A/B commits of a brief, legacy_data's commit, the --scenarios-from head), once each (a short sha and its full id are
 * one). w6678 ran A at dc4643b4c2 and B at 718a14689a, and only 718a14689a was read.
 */
export function pairPlayerShas(commit: string, words: readonly string[]): string[] {
  const out: string[] = [commit.toLowerCase()];
  for (const w of words) {
    for (const h of w.match(SHA_WORD) ?? []) {
      if (!isSha(h)) continue;
      const x = h.toLowerCase();
      const i = out.findIndex((o) => o.startsWith(x) || x.startsWith(o));
      if (i < 0) out.push(x);
      else if (x.length > out[i].length && i > 0) out[i] = x;
    }
  }
  return out;
}

/** w6680: at most this many commits are read for one pair run; a run that names more keeps its mark. */
export const PAIR_COMMITS_MAX = 8;

/**
 * w6680: does every player a pair run names read FF_GAME_DATA_DIR? Each commit pairPlayerShas finds is read through `read`
 * (gameDataDirAt); the mark is cleared only when every one positively reads it. It fails closed: any commit that lacks the
 * backport or cannot be read, a verdict for another commit, a 0.50.x.y build or a Steam or installed player named (no commit
 * to read), or more than PAIR_COMMITS_MAX commits, answers reads false with the reason.
 */
export async function pairDataDirAt(read: (commit: string) => Promise<DataDirVerdict>, commit: string, legacy: string, what: string, brief: string, o: { readFirst?: boolean } = {}): Promise<PairDataDirVerdict> {
  const shas = pairPlayerShas(commit, [legacy, what, brief]);
  const build = otherPlayerInWords(commit, legacy, what, brief, shas);
  // The queue's re-check asks GitHub nothing for a run that names a build (w6235); request_pair (readFirst) reads the commits
  // first, so its refusal leads with what the commits say and filePair adds the build after it (w6451).
  if (build && !o.readFirst) return { reads: false, checked: false, why: build };
  if (shas.length > PAIR_COMMITS_MAX) return { reads: false, checked: false, why: `it names ${shas.length} commits, more than the ${PAIR_COMMITS_MAX} FF Factory reads for the FF_GAME_DATA_DIR backport, so the mark stays (w6680)` };
  const fulls: string[] = [];
  for (const sha of shas) {
    let v: DataDirVerdict;
    try {
      v = await read(sha);
    } catch (e) {
      return { reads: false, checked: false, why: `FF Factory could not check ${sha.slice(0, 10)} for the FF_GAME_DATA_DIR backport (${clip((e as Error).message, 160)}; w6189)` };
    }
    if (!v.reads) return shas.length > 1 ? { ...v, why: `${v.why}; it is one of the ${shas.length} player commits the run names (${shas.map((x) => x.slice(0, 10)).join(', ')}), so the mark stays (w6680)` } : v;
    if (!covers([v.commit], sha)) return { reads: false, checked: false, why: `FF Factory's check answered for ${v.commit.slice(0, 10)}, not ${sha.slice(0, 10)}, so ${sha.slice(0, 10)} was not checked for the FF_GAME_DATA_DIR backport (w6235)` };
    fulls.push(v.commit);
  }
  if (build) return { reads: false, checked: false, why: build };
  return { reads: true, commit: fulls[0], commits: fulls };
}

/**
 * w6458 (w6454's review of PR #1484): a build named without a number, "the host runs the Steam pre-1.0 build", is a player no
 * commit is: Steam's copy, or an installed, published or released one. The mark itself already needs pre-1.0 or 0.50 words
 * (or legacy_data), so these need none of their own. "Steam" alone is not one (a Steam lobby or join runs the PR's own
 * player), and neither is the pre-1.0 release branch or line, which is git, not a build. Fails closed: a false match keeps
 * the mark, and legacy_data "none" is the way out.
 */
export const INSTALLED_BUILD: readonly RegExp[] = [
  // w6516's review: each word after the separator starts with a letter or digit, so a run of punctuation ends in one place
  // (linear, not quadratic, on "Steam------...").
  /\bsteam(?:\s*[^\w\s]s)?[\W_]+(?:[^\W_][\w.-]*\s+){0,3}?(?:builds?|players?|versions?|branch(?:es)?|install(?:ation)?s?|cop(?:y|ies)|releases?|games?)\b/i,
  /\b(?:installed|downloaded)\s+(?:from|via|through|on)\s+steam\b/i,
  /\b(?:installed|published|public|released|release|shipped|live|retail)\s+(?:[\w.-]+\s+){0,2}?(?:builds?|players?|versions?|cop(?:y|ies)|games?)\b/i,
  /\b(?:pre-1\.0|0\.50(?:\.\d+)*)\s+releases?\b(?!\s+(?:branch|line))/i,
  // w6467 (w6463's review of PR #1487): "the client runs Steam 0.50" names Steam's build by a short version, no build word.
  // w6488's and w6497's reviews of PR #1499: any run of non-word characters after Steam or its apostrophe, "Steam [0.50]",
  // "Steam — 0.50", "Steam‘s 0.50", "Steam ver 0.50".
  /\bsteam(?:\s*[^\w\s]s)?[\W_]+(?:(?:ver(?:sion)?|on|at)[\W_]+)?v?(?:pre-1\.0|0\.50(?:\.\d+)*)(?![\w-]|\.\d)/i,
  // w6485 (497345e4's review of PR #1492): the version named before Steam, "0.50 from Steam", "the 0.50 Steam client".
  // and a build word, "the" or any punctuation between: "0.50 build from Steam", "0.50 (from the Steam store)", "0.50 / Steam".
  /\b(?:pre-1\.0|v?0\.50(?:\.\d+)*)\W+(?:(?:build|player|version|copy|client|game)s?\W+)?(?:(?:from|on|via|through|in|over|off)\W+)?(?:the\W+)?steam\b/i,
];

/** The last word of text when text ends in whitespace, else '' (a backwards scan: /(\S+)\s+$/ is quadratic on a long run). */
export const lastWordOf = (text: string): string => {
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  if (end === text.length) return '';
  let start = end;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  return text.slice(start, end);
};

/**
 * w6467 (w6463's review of PR #1487): a match is no other player when it is the PR's own build ("a release player of the PR
 * head", "the Steam game client of the PR build": at most two build nouns, then of/at/from/for/on the PR head or build), or
 * when "release" is the build config ("a debug or release build", or "build a release player" with no pre-1.0 or 0.50 after
 * it). Only those: "the published 0.50 player and the PR head" keeps the mark, failing closed.
 */
export function excusedBuild(said: string, at: number, words: string): boolean {
  // w6469's review: never excused are a match that names an installed copy (published, shipped, live, ...) and Steam with a
  // version ("Steam 0.50"): both name a build no commit is, whatever follows.
  const before = said.slice(0, at);
  // The word just before counts too: "the published release or debug build" matches from "release".
  if (/\b(?:installed|downloaded|published|public|released|shipped|live|retail)\b/i.test(`${lastWordOf(before)} ${words}`)) return false;
  if (/\bsteam\b/i.test(words) && /(?<![\w.])v?(?:pre-1\.0|0\.50)(?!\w)/i.test(words)) return false;
  const after = said.slice(at + words.length);
  // Only build nouns between the match and "of the PR head": "and clients on the PR head" or "host joins from the PR build"
  // names a second player, so it keeps the mark (w6469).
  if (/^\s+(?:(?:game\s+)?(?:build|player|client|copy|version|binary)s?\s+){0,2}?(?:of|at|from|for|on)\s+(?:the\s+)?(?:PR|pull request)(?:'s)?\s+(?:head|build)\b/i.test(after)) return true;
  // A Steam or a pre-1.0/0.50 release is that line's published build, never the build config: "the Steam release or
  // debug build" and "a debug or pre-1.0 release" keep the mark (w6474).
  if (!/\brelease\b/i.test(words) || /^steam|\b(?:pre-1\.0|0\.50)/i.test(words)) return false;
  return /\b(?:debug|development|dev)\b/i.test(words)
    || /\b(?:debug|development|dev)\s+(?:or|and|vs\.?|versus)\s+$/i.test(before)
    || /^\s+(?:or|and|vs\.?|versus)\s+(?:debug|development|dev)\b/i.test(after)
    // "build a release player", but not "builds a release build of pre-1.0": that names the line's release (w6469).
    || (/\bbuild(?:s|ing)?\s+an?\s+$/i.test(before) && /^release\b/i.test(words) && !/\b(?:pre-1\.0|0\.50)\b/i.test(after));
}

/** The first INSTALLED_BUILD match in said that excusedBuild does not excuse (w6467). */
export function installedBuildIn(said: string): string | undefined {
  for (const r of INSTALLED_BUILD) {
    for (const m of said.matchAll(new RegExp(r.source, `${r.flags.replace('g', '')}g`))) if (!excusedBuild(said, m.index, m[0])) return m[0];
  }
  return undefined;
}

/**
 * w6451 (w6442's review of PR #1477): a pair run is marked from its what or brief too (mentionsLegacyPlayer), so those words
 * may name the other player ("the host runs Steam 0.50.0.47") with legacy_data empty. The first such reason in legacy_data,
 * what or brief, in that order, or undefined. `legacy` "none" (saysNone) is passed by the caller as ''.
 */
export const otherPlayerInWords = (commit: string, legacy: string, what: string, brief: string, checked: readonly string[] = [commit]): string | undefined =>
  (legacy ? otherPlayerIn(legacy, commit, 'legacy_data', checked) : undefined) ?? otherPlayerIn(what, commit, 'what', checked) ?? otherPlayerIn(brief, commit, 'brief', checked);

/** What newPair puts after the worker's own brief in a pair run's brief: the words that follow are FF Factory's, not the worker's. */
export const PAIR_FILED_BY = '\n\nFF Factory filed this for worker ';

/** w6451: a pair run's own what and brief as the worker gave them to request_pair (newPair's title and brief, less its own words). */
export const pairAskWords = (w: { title: string; brief: string }): { what: string; brief: string } => {
  const cut = w.brief.lastIndexOf(PAIR_FILED_BY);
  return { what: w.title.replace(/^Pair run for w\d+: /, ''), brief: cut >= 0 ? w.brief.slice(0, cut) : w.brief };
};

// w6206: w6187's pair run was filed with a mistyped full sha (20786882d8bd6c1a…) whose first 10 characters matched the real
// head of game PR #4382 (20786882d8c3f540…), and only its leg's own `gh pr view` caught it. request_pair and start_agent now
// ask GitHub whether the commit exists before a run is placed, through the same read as gameDataDirAt.

/** known: GitHub has the commit (full: its sha). false: it has none (why names it and the head it looks like). undefined: the read failed. */
export type CommitVerdict = { known: true; full: string } | { known: false; why: string } | { known: undefined; why: string };

const commits = new Map<string, string>();
/** Tests only: forget the commits resolved. */
export const forgetCommitChecks = (): void => commits.clear();

/**
 * Does `commit` exist in `repo`? When it does not, look for the commit its first 10 (then 7) characters name, and the
 * branches whose head that is (GitHub's branches-where-head), so the refusal can say what it looks like.
 */
export async function gameCommitAt(gh: Runner, repo: string, commit: string): Promise<CommitVerdict> {
  const c0 = commit.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(c0)) return { known: false, why: `"${clip(c0, 60)}" is not a commit sha (7 to 40 hex; w6206)` };
  const hit = commits.get(c0);
  if (hit) return { known: true, full: hit };
  const r = await shaOf(gh, repo, c0);
  if ('full' in r) {
    commits.set(c0, r.full);
    commits.set(r.full, r.full);
    return { known: true, full: r.full };
  }
  if (!r.missing) return { known: undefined, why: `FF Factory could not read commit ${c0} from GitHub to check that it exists in ${repo} (${r.error}; w6206)` };
  let near = '';
  for (const n of [10, 7]) {
    if (c0.length <= n) continue;
    const p = await shaOf(gh, repo, c0.slice(0, n));
    if (!('full' in p)) continue;
    const b = await gh('gh', ['api', `repos/${repo}/commits/${p.full}/branches-where-head`, '--jq', '.[].name'], { timeoutMs: 30_000 });
    const heads = b.code === 0 ? b.stdout.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 4) : [];
    near = `; it looks like ${p.full}${heads.length ? `, the head of ${heads.join(', ')}` : ''}, which shares its first ${n} characters`;
    break;
  }
  // GitHub answers a short sha that starts more than one commit the same way as one that starts none.
  const none = c0.length < 40 ? 'GitHub finds no single commit that starts with it (none, or more than one: pass the full 40-character sha)' : 'GitHub has no such commit';
  return { known: false, why: `commit ${c0} is not in ${repo}: ${none}${near}. Pass the sha the legs must run (git rev-parse HEAD on the pushed branch; w6206)` };
}
