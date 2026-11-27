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

/** Read GameDataPaths.cs at `commit` in `repo` through GitHub (gh api). A settled answer is kept per full sha. */
export async function gameDataDirAt(gh: Runner, repo: string, commit: string): Promise<DataDirVerdict> {
  const short = commit.slice(0, 10);
  const no = (why: string, checked = false): DataDirVerdict => ({ reads: false, checked, why });
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return no(`"${short}" is not a commit, so FF Factory could not check it for the FF_GAME_DATA_DIR backport (w6189)`);
  const hit = commit.length === 40 ? cache.get(commit.toLowerCase()) : undefined;
  if (hit) return hit;
  const c = await gh('gh', ['api', `repos/${repo}/commits/${commit}`, '--jq', '.sha'], { timeoutMs: 30_000 });
  const full = c.stdout.trim().toLowerCase();
  if (c.code !== 0 || !/^[0-9a-f]{40}$/.test(full)) {
    return no(/HTTP 404|HTTP 422|No commit found/i.test(c.stderr + c.stdout)
      ? `GitHub knows no commit ${short} in ${repo}, so FF Factory could not check it for the FF_GAME_DATA_DIR backport (w6189)`
      : `FF Factory could not read commit ${short} from GitHub to check it for the FF_GAME_DATA_DIR backport (${tail(c)}; w6189)`);
  }
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

/** What a pair run says once its commit was found to read FF_GAME_DATA_DIR (WorkPair.dataDirChecked). */
export const dataDirClearedText = (commit: string): string =>
  `its player at ${commit.slice(0, 10)} reads FF_GAME_DATA_DIR (${GAME_DATA_PATHS}, the backport of game PR #4357), so it is not a pre-w5297 player and its legs may go where sandbox agents measure Low (w6189)`;
