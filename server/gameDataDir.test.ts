import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forgetDataDirChecks, gameDataDirAt, GAME_DATA_PATHS, otherPlayerIn, readsDataDirSource } from './gameDataDir.ts';
import type { Runner } from './githubTokens.ts';

const REPO = 'Final-Factory/FinalFactory';
const NEW = '20786882d8aa00000000000000000000000000aa';
const OLD = 'ac80d7b0bb00000000000000000000000000000b';
// GameDataPaths.cs on pre-1.0 after game PR #4357 (line 33 and the read at line 51), and before it.
const BACKPORT = 'namespace FF {\n  public static class GameDataPaths {\n    public const string RootVariable = "FF_GAME_DATA_DIR";\n    static string Root() { var given = RootOverride(Environment.GetEnvironmentVariable(RootVariable)); return given; }\n  }\n}\n';
const BEFORE = 'using System;\nusing UnityEngine;\nnamespace FF { public static class GameDataPaths { public static string Root => Application.persistentDataPath; } }\n';

/** A gh that knows `files` (full sha -> GameDataPaths.cs, null: no such file) and counts its calls. */
function fakeGh(files: Record<string, string | null>, fail?: 'commit' | 'file'): { gh: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: Runner = async (_cmd, args) => {
    calls.push(args);
    const url = args.find((x) => x.startsWith('repos/'))!;
    const c = /\/commits\/([0-9a-f]+)$/.exec(url);
    if (c) {
      if (fail === 'commit') return { code: 1, stdout: '', stderr: 'error connecting to api.github.com' };
      const full = Object.keys(files).find((k) => k.startsWith(c[1]));
      return full ? { code: 0, stdout: `${full}\n`, stderr: '' } : { code: 1, stdout: '', stderr: `gh: No commit found for SHA: ${c[1]} (HTTP 422)` };
    }
    const f = /\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(url)!;
    assert.equal(f[1], GAME_DATA_PATHS);
    if (fail === 'file') return { code: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' };
    const body = files[f[2]];
    return body == null ? { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } : { code: 0, stdout: body, stderr: '' };
  };
  return { gh, calls };
}

test('w6189: a commit whose GameDataPaths.cs reads FF_GAME_DATA_DIR reads it; an older one does not; a mention in a comment is no read', async () => {
  forgetDataDirChecks();
  const { gh, calls } = fakeGh({ [NEW]: BACKPORT, [OLD]: BEFORE });
  assert.deepEqual(await gameDataDirAt(gh, REPO, '20786882d8'), { reads: true, commit: NEW });
  const old = await gameDataDirAt(gh, REPO, 'ac80d7b0');
  assert.equal(old.reads, false);
  assert.ok(!old.reads && old.checked && /GameDataPaths\.cs at ac80d7b0bb does not read FF_GAME_DATA_DIR: it predates the backport \(game PR #4357/.test(old.why), JSON.stringify(old));
  assert.equal(readsDataDirSource('// TODO: read FF_GAME_DATA_DIR like master\npublic static string Root => Application.persistentDataPath;'), false);
  // A settled answer is kept per full sha: asked again by its full sha, GitHub is not asked again.
  const n = calls.length;
  await gameDataDirAt(gh, REPO, NEW);
  assert.equal(calls.length, n);
});

test('w6189: a commit that cannot be checked fails closed, and says why', async () => {
  forgetDataDirChecks();
  const unknown = await gameDataDirAt(fakeGh({}).gh, REPO, 'deadbeef12');
  assert.ok(!unknown.reads && !unknown.checked && /^GitHub knows no commit deadbeef12 in Final-Factory\/FinalFactory, so FF Factory could not check it/.test(unknown.why), JSON.stringify(unknown));
  const down = await gameDataDirAt(fakeGh({ [NEW]: BACKPORT }, 'commit').gh, REPO, '20786882d8');
  assert.ok(!down.reads && !down.checked && /could not read commit 20786882d8 from GitHub .*error connecting/.test(down.why), JSON.stringify(down));
  const file = await gameDataDirAt(fakeGh({ [NEW]: BACKPORT }, 'file').gh, REPO, '20786882d8');
  assert.ok(!file.reads && !file.checked && /could not read Assets\/Scripts\/FFCore\/GameData\/GameDataPaths\.cs at 20786882d8 .*502/.test(file.why), JSON.stringify(file));
  // A failed read is not kept: the next ask reads GitHub again and finds the backport.
  assert.equal((await gameDataDirAt(fakeGh({ [NEW]: BACKPORT }).gh, REPO, NEW)).reads, true);
  const none = await gameDataDirAt(fakeGh({ [OLD]: null }).gh, REPO, OLD);
  assert.ok(!none.reads && none.checked && /has no Assets\/Scripts\/FFCore\/GameData\/GameDataPaths\.cs/.test(none.why));
  assert.equal((await gameDataDirAt(fakeGh({}).gh, REPO, 'pre-1.0')).reads, false, 'a branch name is not a commit');
});

// w6235 (w6192's review of PR #1402, nit 2): the source test needs both halves; nothing tested the environment read.
test('w6235: the FF_GAME_DATA_DIR literal without an environment read is no read; with one it is', () => {
  assert.equal(readsDataDirSource('public static class GameDataPaths { public const string RootVariable = "FF_GAME_DATA_DIR"; public static string Root => Application.persistentDataPath; }'), false);
  assert.equal(readsDataDirSource('public const string RootVariable = "FF_GAME_DATA_DIR";\nvar given = Environment.GetEnvironmentVariable(RootVariable);'), true);
  assert.equal(readsDataDirSource(BACKPORT), true);
  assert.equal(readsDataDirSource(BEFORE), false);
});

// w6235 (w6192's should-fix-later point): legacy_data about another player than the checked commit keeps the mark.
test('w6235: legacy_data that names another commit or a 0.50 build is not settled by the checked commit', () => {
  assert.match(otherPlayerIn('the host runs the Steam pre-1.0 0.50.0.47 build', '20786882d8') ?? '', /^its legacy_data names build 0\.50\.0\.47, but FF Factory checked only 20786882d8 for the FF_GAME_DATA_DIR backport, so the mark stays \(w6235\)$/);
  assert.match(otherPlayerIn('the client runs ac80d7b0bb', NEW) ?? '', /names commit ac80d7b0bb, but FF Factory checked only 20786882d8/);
  // The checked commit itself, by a short or a full sha, and words with no sha or version, say nothing about another player.
  assert.equal(otherPlayerIn('20786882d8 is a pre-1.0 PR head', NEW), undefined);
  assert.equal(otherPlayerIn(`the pre-1.0 line at ${NEW}`, '20786882d8'), undefined);
  assert.equal(otherPlayerIn('read from its words: pre-1.0 or the 0.50 line; it acceded to the deadbeef plan', NEW), undefined);
});

test('w6458: a build named without a number keeps the mark; a PR head, a lobby or the release branch does not', () => {
  assert.match(otherPlayerIn('the host runs the Steam pre-1.0 build', NEW) ?? '', /^its legacy_data names a build no commit is \("Steam pre-1\.0 build"\), but FF Factory checked only 20786882d8 for the FF_GAME_DATA_DIR backport, so the mark stays \(w6235\)$/);
  for (const t of ['the host runs the Steam pre-1.0 build', 'the client was installed from Steam', 'the published 0.50 player', 'the pre-1.0 release', "Steam's 0.50 version", 'the installed pre-1.0 copy', 'the live 0.50 build']) {
    assert.ok(otherPlayerIn(t, NEW), t);
  }
  for (const t of ['join through a Steam lobby', 'the pre-1.0 release branch at the PR head', 'Build the 0.50 line at the PR head and run the MP scenarios.', 'Run the MP scenarios at the PR head.', 'MP-activity-fingerprint on pre-1.0', 'Build a player of the 0.50 line']) {
    assert.equal(otherPlayerIn(t, NEW), undefined, t);
  }
});

test('w6467: Steam and a short version keep the mark; the PR\'s own release or Steam build, and release as the build config, do not', () => {
  assert.match(otherPlayerIn('the client runs Steam 0.50', NEW) ?? '', /names a build no commit is \("Steam 0\.50"\)/);
  for (const t of ['the client runs Steam 0.50', 'the host runs Steam pre-1.0; the client the PR head', "Steam's 0.50.1 on the host", 'the published 0.50 player and the PR head',
    'the host runs the Steam 0.50 build, the client a release player of the PR head', 'the client runs a release build of pre-1.0',
    'the published 0.50 player runs on the host, and the client on the PR head',
    // w6469's review of PR #1492 (measured CLEAR at a5296476): a joining word or a role before "the PR head" is a second player,
    'the host runs Steam 0.50 and clients on the PR head', 'the host runs Steam 0.50 vs client on the PR head', 'Steam pre-1.0 and me on the PR head',
    'Steam 0.50 host joins from the PR build', 'Steam 0.50 for testing on the PR head', 'the host runs Steam 0.50 client on the PR head',
    // a comma or a slash is no "debug or release", and an installed-type word is never excused,
    'the host has the release build, debug off', 'the host runs the published release build, dev build on the client', 'the host runs the release build / debug client on the PR head',
    // and "builds a release build" of pre-1.0 or 0.50 names that line's release.
    'the tester builds a release build of pre-1.0', 'Build a release player for the 0.50 line',
    // Each of these pins one guard: a non-noun word before the PR head, an installed-type word, a slash before "release".
    'the Steam build and clients on the PR head', 'the published player of the PR head', 'the host runs the published release or debug build', 'the host runs dev / release build',
    // w6474's review of PR #1492 (measured CLEAR at 08a1ae2e): a Steam or a pre-1.0/0.50 release is no build config.
    'debug and 0.50 release on the host', 'a debug or pre-1.0 release', 'the 0.50 release or debug build',
    'the host runs the Steam release or debug build', 'the Steam dev release', "Steam's debug release"]) {
    assert.ok(otherPlayerIn(t, NEW), t);
  }
  for (const t of ['Build a release player of the PR head', 'the 0.50 release build at the PR head', 'join with the Steam game client of the PR build', 'a Steam lobby on 0.50',
    'the release build for the PR\'s head', 'Build a release player and run the MP scenarios.', 'a debug or release build of the 0.50 line', 'a release or debug player of the 0.50 line',
    'a debug or release build', 'a dev vs release build', 'release or development build of the PR head', 'the Steam build of the PR head',
    'the pre-1.0 release branch']) {
    assert.equal(otherPlayerIn(t, NEW), undefined, t);
  }
});

// w6485 (497345e4's reviews of PR #1492): plurals, and the version named before Steam, keep the mark too.
test('w6485: plural Steam builds and a version named before Steam keep the mark; the PR\'s own Steam builds and a lobby do not', () => {
  assert.match(otherPlayerIn('0.50 from Steam', NEW) ?? '', /names a build no commit is \("0\.50 from Steam"\)/);
  for (const t of ['the Steam players and builds of the PR head', 'Steam builds and the clients on the PR head', '0.50 from Steam', 'pre-1.0 on Steam',
    'the 0.50 Steam client', 'Steam v0.50', 'Steam (pre-1.0)', 'the host runs the Steam copies', 'the 0.50 Steam client of the PR head', 'v0.50.1 via Steam']) {
    assert.ok(otherPlayerIn(t, NEW), t);
  }
  for (const t of ['a Steam lobby on 0.50', 'the Steam build of the PR head', 'the Steam builds of the PR head', 'Build a release player of the PR head',
    'join through a Steam lobby', 'join with the Steam game client of the PR build']) {
    assert.equal(otherPlayerIn(t, NEW), undefined, t);
  }
});

// w6488's review of PR #1499 (measured lifting the mark at 03344c09).
test('w6485: plurals of every build pattern, a word or punctuation around Steam and its version, and a curly apostrophe keep the mark', () => {
  for (const t of ['the published builds', 'shipped players', 'the live copies', 'pre-1.0 releases', '0.50 releases',
    '0.50 build from Steam', 'the 0.50 version on Steam', 'pre-1.0 from the Steam client', '0.50 from the Steam store', '0.50 off Steam',
    '0.50 (from Steam)', '0.50, from Steam', '0.50-Steam',
    'Steam [pre-1.0]', 'Steam [0.50]', 'Steam: 0.50', 'Steam, pre-1.0', 'Steam - 0.50', 'Steam-0.50', 'Steam-pre-1.0', 'Steam ver 0.50',
    'Steam on pre-1.0', 'Steam at 0.50', 'the Steam-0.50 build of the PR head', 'the 0.50-Steam client of the PR head',
    'Steam’s 0.50', 'Steam’s build']) {
    assert.ok(otherPlayerIn(t, NEW), t);
  }
  for (const t of ['a Steam lobby on 0.50', 'the Steam builds of the PR head', 'Steam’s build of the PR head', 'join through a Steam lobby',
    'the pre-1.0 release branch', 'a debug or release build', 'Build a release player of the PR head']) {
    assert.equal(otherPlayerIn(t, NEW), undefined, t);
  }
});
