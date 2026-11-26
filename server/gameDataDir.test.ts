import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forgetDataDirChecks, gameDataDirAt, GAME_DATA_PATHS, readsDataDirSource } from './gameDataDir.ts';
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
