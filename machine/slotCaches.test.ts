import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  MARKER,
  QUIET_MS,
  REFRESH_MS,
  SLOT_CACHE_TOOLS,
  SlotCaches,
  mergeBack,
  missingSlotCaches,
  RETRY_MS,
  mergeEntries,
  okSandboxId,
  readMarker,
  sharedLockBlockers,
  sharedLockLine,
  sharedLockedFolders,
  sharedLockSetting,
  slotAuditDir,
  slotCacheDir,
  slotCacheEnv,
  watchShared,
  sharedEventHandler,
  DAEMON_GRACE_MS,
  STALE_MS,
  type SharedLockSetting,
} from "./slotCaches.ts";

/**
 * w5615: per-slot tool caches and the shared-cache lock (machine/slotCaches.ts). Real folders under a temp root; copyTree and
 * removeTree are fs.cpSync and fs.rmSync, as server/proc.ts's are on a disk without block clones.
 */

function tmp(t: TestContext): string {
  const d = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "slot-caches-"),
  );
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const put = (file: string, text = "x") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const copyTree = async (src: string, dst: string) =>
  fs.cpSync(src, dst, { recursive: true });
const removeTree = async (dir: string) =>
  fs.rmSync(dir, { recursive: true, force: true });
const seedDir = (root: string, ...p: string[]) =>
  path.join(root, "cache", ...p);
const writeMarker = (
  root: string,
  sandbox: string,
  tools: string[],
  made = 1,
) => {
  const dir = slotCacheDir(root, sandbox);
  put(path.join(dir, MARKER), JSON.stringify({ v: 1, made, tools }));
  return dir;
};

// ---------------------------------------------------------------- the setting and the environment

test("sharedLockSetting passes warn, on and off, and reads anything else as off", () => {
  assert.equal(sharedLockSetting("warn"), "warn");
  assert.equal(sharedLockSetting("on"), "on");
  assert.equal(sharedLockSetting("off"), "off");
  for (const junk of [undefined, null, "", "ON", "true", 1, true, {}, ["on"]])
    assert.equal(sharedLockSetting(junk), "off");
});

test("okSandboxId takes one plain path segment and nothing that climbs", () => {
  for (const ok of ["slot3", "a", "Slot_1", "w5615.x-2"])
    assert.ok(okSandboxId(ok), ok);
  for (const bad of [
    undefined,
    "",
    ".",
    "..",
    "../x",
    "a/b",
    "a\\b",
    "a..b",
    ".hidden",
    "-x",
    "a b",
    "x".repeat(65),
  ])
    assert.ok(!okSandboxId(bad), String(bad));
});

test("slotCacheEnv: off, no root or a bad sandbox id name nothing", (t) => {
  const root = tmp(t);
  writeMarker(root, "slot3", ["uv"]);
  assert.deepEqual(slotCacheEnv(root, "slot3", "off", "linux"), {});
  assert.deepEqual(slotCacheEnv(undefined, "slot3", "warn", "linux"), {});
  for (const bad of [undefined, "", "..", "../slot3", "a..b", "a/b"]) {
    assert.deepEqual(slotCacheEnv(root, bad, "warn", "linux"), {}, String(bad));
    assert.deepEqual(slotCacheEnv(root, bad, "on", "linux"), {}, String(bad));
  }
});

test("slotCacheEnv warn: no marker names only the slot's audit folder; the shared seeds stay", (t) => {
  const root = tmp(t);
  assert.deepEqual(slotCacheEnv(root, "slot3", "warn", "linux"), {
    FF_DETERMINISM_AUDIT_DIR: slotAuditDir(root, "slot3"),
  });
  assert.equal(
    slotAuditDir(root, "slot3"),
    path.join(root, "cache", "slots", "slot3", "determinism-audit"),
  );
});

test("slotCacheEnv warn: a marked tool whose folder exists points at the clone; an unmarked or missing one does not", (t) => {
  const root = tmp(t);
  const dir = writeMarker(root, "slot3", [
    "uv",
    "pip",
    path.join("nuget", "packages"),
  ]);
  fs.mkdirSync(path.join(dir, "uv"), { recursive: true });
  fs.mkdirSync(path.join(dir, "npm"), { recursive: true }); // there, but not in the marker
  fs.mkdirSync(path.join(dir, "nuget", "packages"), { recursive: true });
  // pip is in the marker but its folder is gone
  assert.deepEqual(slotCacheEnv(root, "slot3", "warn", "linux"), {
    FF_DETERMINISM_AUDIT_DIR: slotAuditDir(root, "slot3"),
    UV_CACHE_DIR: path.join(root, "cache", "slots", "slot3", "uv"),
    NUGET_PACKAGES: path.join(
      root,
      "cache",
      "slots",
      "slot3",
      "nuget",
      "packages",
    ),
  });
  // another sandbox's marker does not count
  assert.deepEqual(Object.keys(slotCacheEnv(root, "slot4", "warn", "linux")), [
    "FF_DETERMINISM_AUDIT_DIR",
  ]);
});

test("slotCacheEnv on: every tool of the platform is named, with or without a marker", (t) => {
  const root = tmp(t);
  const want = Object.fromEntries(
    SLOT_CACHE_TOOLS.map((x) => [
      x.env,
      path.join(root, "cache", "slots", "slot3", x.dir),
    ]),
  );
  assert.deepEqual(slotCacheEnv(root, "slot3", "on", "linux"), {
    FF_DETERMINISM_AUDIT_DIR: slotAuditDir(root, "slot3"),
    ...want,
  });
  assert.equal(
    slotCacheEnv(root, "slot3", "on", "linux").UV_CACHE_DIR,
    path.join(root, "cache", "slots", "slot3", "uv"),
  );
});

test("slotCacheEnv skips a tool that is not on the platform (the tool's `platforms`)", (t) => {
  const root = tmp(t);
  const tool = SLOT_CACHE_TOOLS.find((x) => x.dir === "dotnet")!;
  const was = tool.platforms;
  tool.platforms = ["win32"];
  try {
    const dir = writeMarker(root, "slot3", ["dotnet", "uv"]);
    fs.mkdirSync(path.join(dir, "dotnet"));
    fs.mkdirSync(path.join(dir, "uv"));
    assert.equal(
      slotCacheEnv(root, "slot3", "on", "linux").DOTNET_CLI_HOME,
      undefined,
    );
    assert.equal(
      slotCacheEnv(root, "slot3", "warn", "linux").DOTNET_CLI_HOME,
      undefined,
    );
    assert.equal(
      slotCacheEnv(root, "slot3", "on", "win32").DOTNET_CLI_HOME,
      path.join(dir, "dotnet"),
    );
    assert.equal(
      slotCacheEnv(root, "slot3", "warn", "win32").DOTNET_CLI_HOME,
      path.join(dir, "dotnet"),
    );
    assert.ok(slotCacheEnv(root, "slot3", "on", "linux").UV_CACHE_DIR);
  } finally {
    tool.platforms = was;
  }
});

test("readMarker reads a whole marker and nothing half-made or foreign", (t) => {
  const dir = path.join(tmp(t), "slot");
  assert.equal(readMarker(dir), undefined);
  put(path.join(dir, MARKER), '{"v":1,"made":5,"tools":["uv"]}');
  assert.deepEqual(readMarker(dir), { v: 1, made: 5, tools: ["uv"] });
  for (const bad of [
    "",
    "{",
    '{"v":2,"made":5,"tools":[]}',
    '{"v":1,"made":"x","tools":[]}',
    '{"v":1,"made":5}',
  ]) {
    fs.writeFileSync(path.join(dir, MARKER), bad);
    assert.equal(readMarker(dir), undefined, bad);
  }
});

/** A whole clone: a marker that lists every cache, and each cache's folder. */
const wholeClone = (root: string, sandbox: string) => {
  const dir = writeMarker(root, sandbox, SLOT_CACHE_TOOLS.map((x) => x.dir));
  for (const x of SLOT_CACHE_TOOLS)
    fs.mkdirSync(path.join(dir, x.dir), { recursive: true });
  return dir;
};

// ---------------------------------------------------------------- SlotCaches: make, tick, refresh

/** A root with a seed `uv` cache (one wheel archive and one pointer) and a SlotCaches over `sandboxes`. */
function pool(
  t: TestContext,
  sandboxes: { id: string; idle: boolean }[],
  o: {
    copy?: typeof copyTree;
    refreshMs?: number;
    setting?: SharedLockSetting;
  } = {},
) {
  const root = tmp(t);
  put(seedDir(root, "uv", "archive-v0", "seed1", "file"), "seed one");
  put(seedDir(root, "uv", "wheels-v1", "seedptr.json"), "{}");
  const log: string[] = [];
  const clock = { t: Date.now() };
  const caches = new SlotCaches({
    root,
    setting: o.setting ?? "warn",
    sandboxes: () => sandboxes,
    copy: o.copy ?? copyTree,
    removeTree,
    log: (l) => log.push(l),
    now: () => clock.t,
    refreshMs: o.refreshMs,
  });
  return { root, log, clock, caches, sandboxes };
}

test("tick: an idle sandbox with no clone gets its clones from the seed and a marker", async (t) => {
  const p = pool(t, [{ id: "slot1", idle: true }]);
  const line = await p.caches.tick();
  const dir = slotCacheDir(p.root, "slot1");
  const m = readMarker(dir)!;
  assert.equal(m.made, p.clock.t);
  assert.deepEqual(
    m.tools,
    SLOT_CACHE_TOOLS.map((x) => x.dir),
    "every tool has a folder, an empty one where no seed exists",
  );
  assert.equal(
    fs.readFileSync(
      path.join(dir, "uv", "archive-v0", "seed1", "file"),
      "utf8",
    ),
    "seed one",
  );
  assert.ok(fs.existsSync(path.join(dir, "uv", "wheels-v1", "seedptr.json")));
  assert.ok(
    fs.statSync(path.join(dir, "pip")).isDirectory(),
    "no seed: an empty folder",
  );
  assert.ok(fs.statSync(path.join(dir, "nuget", "packages")).isDirectory());
  assert.ok(fs.statSync(slotAuditDir(p.root, "slot1")).isDirectory());
  assert.match(line!, /slot caches: slot1: made from the shared seed/);
  assert.match(line!, /\(w5615\)$/);
  assert.deepEqual(p.log, [line]);
  assert.deepEqual(
    fs.readdirSync(path.join(dir, "uv")).sort(),
    ["archive-v0", "wheels-v1"],
    "no .ff-new- leftovers",
  );
  // the seed is untouched, and now the environment names the clone
  assert.ok(
    fs.existsSync(seedDir(p.root, "uv", "archive-v0", "seed1", "file")),
  );
  assert.equal(
    slotCacheEnv(p.root, "slot1", "warn", "linux").UV_CACHE_DIR,
    path.join(dir, "uv"),
  );
  // nothing more to do: a second tick answers nothing
  assert.equal(await p.caches.tick(), undefined);
});

test("tick: setting off does nothing", async (t) => {
  const p = pool(t, [{ id: "slot1", idle: true }], { setting: "off" });
  assert.equal(await p.caches.tick(), undefined);
  assert.equal(fs.existsSync(path.join(p.root, "cache", "slots")), false);
});

test("tick: at most one sandbox per tick, in the pool's order; a bad id is passed over", async (t) => {
  const p = pool(t, [
    { id: "../evil", idle: true },
    { id: "slot1", idle: true },
    { id: "slot2", idle: true },
  ]);
  await p.caches.tick();
  assert.ok(readMarker(slotCacheDir(p.root, "slot1")));
  assert.equal(readMarker(slotCacheDir(p.root, "slot2")), undefined);
  await p.caches.tick();
  assert.ok(readMarker(slotCacheDir(p.root, "slot2")));
  assert.deepEqual(fs.readdirSync(path.join(p.root, "cache", "slots")).sort(), [
    "slot1",
    "slot2",
  ]);
  assert.equal(p.log.length, 2);
});

test("tick: a busy sandbox is not refreshed; one with no clone yet is cloned busy or not", async (t) => {
  const p = pool(t, [{ id: "slot1", idle: false }], { refreshMs: 1_000 });
  // No clone yet: made though busy (the seed is not written by anyone else; its clone is named from its next run on).
  await p.caches.tick();
  const first = readMarker(slotCacheDir(p.root, "slot1"))!;
  assert.ok(first);
  // Old, but busy: left alone.
  p.clock.t += 10 * REFRESH_MS;
  assert.equal(await p.caches.tick(), undefined);
  assert.equal(readMarker(slotCacheDir(p.root, "slot1"))!.made, first.made);
  // Idle at last: made again.
  p.sandboxes[0].idle = true;
  assert.match((await p.caches.tick())!, /made again/);
  assert.equal(readMarker(slotCacheDir(p.root, "slot1"))!.made, p.clock.t);
});

test("tick: a clone younger than refreshMs is left, an older idle one is made again", async (t) => {
  const p = pool(t, [{ id: "slot1", idle: true }]);
  await p.caches.tick();
  p.clock.t += REFRESH_MS - 1_000;
  assert.equal(await p.caches.tick(), undefined);
  p.clock.t += 2_000;
  assert.match(
    (await p.caches.tick())!,
    /slot1: made again from the shared seed/,
  );
});

test("refresh: the new archive and pointer go back to the seed first; an existing seed entry is never overwritten", async (t) => {
  const p = pool(t, [{ id: "slot1", idle: true }]);
  await p.caches.tick();
  const clone = path.join(slotCacheDir(p.root, "slot1"), "uv");
  put(path.join(clone, "archive-v0", "newhash", "wheel.bin"), "new wheel");
  put(path.join(clone, "wheels-v1", "new.json"), '{"new":1}');
  put(path.join(clone, "archive-v0", "seed1", "file"), "the slot changed it"); // the seed has seed1: kept as it is
  put(path.join(clone, "wheels-v1", "seedptr.json"), '{"changed":1}');
  put(path.join(clone, "environments-v1", "venv", "bin"), "in place"); // not content-addressed: stays in the clone
  put(path.join(clone, "simple-v1", "idx"), "index");
  p.clock.t += REFRESH_MS + QUIET_MS + 1_000; // the real mtimes are long past the quiet time
  const line = (await p.caches.tick())!;
  assert.match(line, /slot1: made again from the shared seed/);
  assert.match(line, /2 new entries merged back first/);
  const seed = seedDir(p.root, "uv");
  assert.equal(
    fs.readFileSync(
      path.join(seed, "archive-v0", "newhash", "wheel.bin"),
      "utf8",
    ),
    "new wheel",
  );
  assert.equal(
    fs.readFileSync(path.join(seed, "wheels-v1", "new.json"), "utf8"),
    '{"new":1}',
  );
  assert.equal(
    fs.readFileSync(path.join(seed, "archive-v0", "seed1", "file"), "utf8"),
    "seed one",
    "never overwritten",
  );
  assert.equal(
    fs.readFileSync(path.join(seed, "wheels-v1", "seedptr.json"), "utf8"),
    "{}",
    "never overwritten",
  );
  assert.ok(!fs.existsSync(path.join(seed, "environments-v1")));
  assert.ok(!fs.existsSync(path.join(seed, "simple-v1")));
  assert.deepEqual(
    fs.readdirSync(path.join(seed, "archive-v0")).sort(),
    ["newhash", "seed1"],
    "no .ff-merge- leftovers",
  );
  // The clone is made again from the seed: it has what any slot downloaded, and not its own in-place files.
  assert.equal(
    fs.readFileSync(
      path.join(clone, "archive-v0", "newhash", "wheel.bin"),
      "utf8",
    ),
    "new wheel",
  );
  assert.equal(
    fs.readFileSync(path.join(clone, "archive-v0", "seed1", "file"), "utf8"),
    "seed one",
  );
  assert.ok(!fs.existsSync(path.join(clone, "environments-v1")));
  assert.equal(readMarker(slotCacheDir(p.root, "slot1"))!.made, p.clock.t);
  assert.deepEqual(
    fs
      .readdirSync(slotCacheDir(p.root, "slot1"))
      .filter((n) => /^\.ff-(old|new)-/.test(n)),
    [],
    "no .ff-old- or .ff-new- leftovers",
  );
});

test("refresh: what a slot downloaded reaches the next slot made from the seed", async (t) => {
  const p = pool(t, [{ id: "slot1", idle: true }]);
  await p.caches.tick();
  put(
    path.join(slotCacheDir(p.root, "slot1"), "uv", "archive-v0", "shared", "f"),
    "from slot1",
  );
  p.clock.t += REFRESH_MS + QUIET_MS + 1_000;
  await p.caches.tick();
  p.sandboxes.push({ id: "slot2", idle: true });
  await p.caches.tick();
  assert.equal(
    fs.readFileSync(
      path.join(
        slotCacheDir(p.root, "slot2"),
        "uv",
        "archive-v0",
        "shared",
        "f",
      ),
      "utf8",
    ),
    "from slot1",
  );
});

test("refresh: an entry touched within the quiet time is left in the clone, one older goes back", async (t) => {
  // refreshMs 1 s so the refresh runs at once; `now` is real time, so the files written now are inside QUIET_MS.
  const p = pool(t, [{ id: "slot1", idle: true }], { refreshMs: 1_000 });
  p.clock.t = Date.now() - 10_000;
  await p.caches.tick();
  const clone = path.join(slotCacheDir(p.root, "slot1"), "uv");
  put(path.join(clone, "archive-v0", "fresh", "f"), "being written");
  put(path.join(clone, "archive-v0", "settled", "f"), "done");
  const long = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(clone, "archive-v0", "settled"), long, long);
  p.clock.t = Date.now();
  const line = (await p.caches.tick())!;
  assert.match(line, /1 new entry merged back first/);
  const seed = seedDir(p.root, "uv", "archive-v0");
  assert.ok(fs.existsSync(path.join(seed, "settled", "f")));
  assert.ok(!fs.existsSync(path.join(seed, "fresh")));
});

test("refresh: NuGet merges a package version only once .nupkg.metadata is there, and Playwright a revision with INSTALLATION_COMPLETE", async (t) => {
  const p = pool(t, [{ id: "slot1", idle: true }]);
  await p.caches.tick();
  const dir = slotCacheDir(p.root, "slot1");
  put(
    path.join(dir, "nuget", "packages", "pkg.a", "1.0.0", ".nupkg.metadata"),
    "{}",
  );
  put(path.join(dir, "nuget", "packages", "pkg.a", "1.0.0", "lib.dll"), "dll");
  put(path.join(dir, "nuget", "packages", "pkg.a", "2.0.0", "lib.dll"), "half"); // no metadata yet
  put(
    path.join(dir, "nuget", "packages", ".tools", "1.0.0", ".nupkg.metadata"),
    "{}",
  ); // a dot folder: not a package id
  put(
    path.join(dir, "ms-playwright", "chromium-1200", "INSTALLATION_COMPLETE"),
    "",
  );
  put(path.join(dir, "ms-playwright", "chromium-1200", "chrome"), "bin");
  put(path.join(dir, "ms-playwright", "firefox-9", "chrome"), "half");
  put(path.join(dir, "dotnet", "sentinel"), "the slot's own"); // a tool home: never merged
  put(path.join(dir, "pip", "http-v2", "a", "b"), "cached");
  put(path.join(dir, "pip", "selfcheck", "x"), "not named by a hash");
  put(
    path.join(dir, "npm", "_cacache", "content-v2", "sha512", "ab", "cd"),
    "blob",
  );
  put(path.join(dir, "npm", "_cacache", "tmp", "part.tmp"), "half");
  p.clock.t += REFRESH_MS + QUIET_MS + 1_000;
  await p.caches.tick();
  const c = (...x: string[]) => seedDir(p.root, ...x);
  assert.equal(
    fs.readFileSync(
      c("nuget", "packages", "pkg.a", "1.0.0", "lib.dll"),
      "utf8",
    ),
    "dll",
  );
  assert.ok(!fs.existsSync(c("nuget", "packages", "pkg.a", "2.0.0")));
  assert.ok(!fs.existsSync(c("nuget", "packages", ".tools")));
  assert.equal(
    fs.readFileSync(c("ms-playwright", "chromium-1200", "chrome"), "utf8"),
    "bin",
  );
  assert.ok(!fs.existsSync(c("ms-playwright", "firefox-9")));
  assert.ok(!fs.existsSync(c("dotnet", "sentinel")));
  assert.equal(
    fs.readFileSync(c("pip", "http-v2", "a", "b"), "utf8"),
    "cached",
  );
  assert.ok(!fs.existsSync(c("pip", "selfcheck")));
  assert.equal(
    fs.readFileSync(
      c("npm", "_cacache", "content-v2", "sha512", "ab", "cd"),
      "utf8",
    ),
    "blob",
  );
  assert.ok(
    !fs.existsSync(c("npm", "_cacache", "tmp", "part.tmp")),
    "a .tmp file is never an entry",
  );
});

test("make: a tool whose copy fails is named in the line and left out of the marker; the others are made", async (t) => {
  const failing: typeof copyTree = async (src, dst) => {
    if (src.endsWith(path.join("cache", "uv")))
      throw new Error("disk full\nmore");
    fs.cpSync(src, dst, { recursive: true });
  };
  const p = pool(t, [{ id: "slot1", idle: true }], { copy: failing });
  const line = (await p.caches.tick())!;
  assert.match(line, /failed: uv \(disk full\)/);
  const m = readMarker(slotCacheDir(p.root, "slot1"))!;
  assert.ok(!m.tools.includes("uv"));
  assert.ok(m.tools.includes("pip"));
  assert.ok(!fs.existsSync(path.join(slotCacheDir(p.root, "slot1"), "uv")));
  assert.deepEqual(
    fs
      .readdirSync(slotCacheDir(p.root, "slot1"))
      .filter((n) => n.startsWith(".ff-new")),
    [],
  );
  // not in the marker: warn keeps naming the shared seed for uv
  assert.equal(
    slotCacheEnv(p.root, "slot1", "warn", "linux").UV_CACHE_DIR,
    undefined,
  );
});

test("mergeEntries and mergeBack: the rule picks the entries, and a copy that throws is not renamed in", async (t) => {
  const root = tmp(t);
  const clone = path.join(root, "clone");
  const seed = path.join(root, "seed");
  fs.mkdirSync(seed); // make() makes the seed folder and checks it before it merges
  put(path.join(clone, "archive-v0", "h1", "f"));
  put(path.join(clone, "archive-v0", "h2", "f"));
  put(path.join(clone, "archive-v0", ".ff-merge-1-h3", "f"));
  put(path.join(clone, "archive-v0", "loose-file"));
  put(path.join(clone, MARKER), "{}");
  const rule = { dirs: [{ top: /^archive-v\d+$/, depth: 1 }] };
  const now = Date.now() + 3600_000;
  assert.deepEqual(
    mergeEntries(clone, rule, now)
      .map((e) => e.rel)
      .sort(),
    [path.join("archive-v0", "h1"), path.join("archive-v0", "h2")],
  );
  assert.deepEqual(
    mergeEntries(clone, rule, Date.now()),
    [],
    "all inside the quiet time",
  );
  let calls = 0;
  const flaky: typeof copyTree = async (s, d) => {
    if (++calls === 1) {
      fs.mkdirSync(d);
      throw new Error("boom");
    }
    fs.cpSync(s, d, { recursive: true });
  };
  assert.equal(await mergeBack(clone, seed, rule, flaky, now), 1);
  assert.deepEqual(
    fs.readdirSync(path.join(seed, "archive-v0")),
    ["h2"],
    "the failed copy left nothing, not even its temp folder",
  );
});

test("w6212 L3/B2: merge-back never replaces a seed file and writes nothing through a link in the seed", async (t) => {
  const root = tmp(t);
  const clone = path.join(root, "clone");
  const seed = path.join(root, "seed");
  const rule = { dirs: [{ top: /^archive-v\d+$/, depth: 1 }], files: [/^wheels-v\d+\/[^/]+\.whl$/] };
  put(path.join(clone, "archive-v0", "h1", "f"), "new");
  put(path.join(clone, "wheels-v0", "a.whl"), "new");
  put(path.join(seed, "wheels-v0", "a.whl"), "old");
  // the seed's archive-v0 is a link to a folder elsewhere: nothing lands there
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(seed, "archive-v0"));
  const now = Date.now() + 3600_000;
  await mergeBack(clone, seed, rule as never, copyTree, now);
  assert.equal(fs.readFileSync(path.join(seed, "wheels-v0", "a.whl"), "utf8"), "old");
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

// ---------------------------------------------------------------- the lock: folders, blockers, line

test("sharedLockedFolders: the cache seeds, players, seed and tools; never the slots, tool homes or cargo", () => {
  const root = path.join(path.sep, "w");
  const f = sharedLockedFolders(root);
  for (const x of SLOT_CACHE_TOOLS)
    assert.ok(f.includes(path.join(root, "cache", x.dir)), x.dir);
  for (const x of ["players", "seed", "tools"])
    assert.ok(f.includes(path.join(root, x)), x);
  assert.ok(f.includes(path.join(root, "cache", "nuget", "packages")));
  assert.ok(!f.some((x) => x.split(path.sep).includes("slots")));
  for (const x of ["uv-tools", "uv-bin", "xdg", "cargo"])
    assert.ok(!f.includes(path.join(root, "cache", x)), x);
  assert.ok(!f.includes(path.join(root, "cache")));
});

test("sharedLockBlockers: no root is one blocker; a sandbox with no marker is named; all marked is none", (t) => {
  assert.deepEqual(sharedLockBlockers(undefined, ["slot1"]), [
    "this install has no worker root",
  ]);
  const root = tmp(t);
  assert.deepEqual(sharedLockBlockers(root, []), []);
  const two = sharedLockBlockers(root, ["slot1", "slot2"]);
  assert.equal(two.length, 1);
  assert.match(
    two[0],
    /^sandboxes slot1, slot2 without their own cache clones/,
  );
  wholeClone(root, "slot1");
  const one = sharedLockBlockers(root, ["slot1", "slot2"]);
  assert.equal(one.length, 1);
  assert.match(one[0], /^sandbox slot2 without their own cache clones/);
  assert.ok(!one[0].includes("slot1"));
  wholeClone(root, "slot2");
  assert.deepEqual(sharedLockBlockers(root, ["slot1", "slot2"]), []);
  assert.deepEqual(
    sharedLockBlockers(root, ["slot1", "../x"]),
    [],
    "a bad id is not a sandbox",
  );
});

test('sharedLockLine: nothing for off; warn and on say w5615, and blockers hold "on" off', () => {
  assert.equal(sharedLockLine("off"), undefined);
  assert.equal(sharedLockLine("off", ["x"]), undefined);
  const warn = sharedLockLine("warn")!;
  assert.match(warn, /^shared lock: warn only \(w5615\)/);
  assert.ok(!warn.includes("would stay off"));
  assert.match(
    sharedLockLine("warn", ["slot2 has no clones"])!,
    /With "on" it would stay off: slot2 has no clones/,
  );
  assert.match(
    sharedLockLine("on")!,
    /^shared lock: "on" asked, but this release enforces nothing yet and runs as warn/,
  );
  const held = sharedLockLine("on", ["slot2 has no clones"])!;
  assert.match(held, /on asked, but held off .*: slot2 has no clones/);
  assert.ok(!held.includes("read-only"));
});

// ---------------------------------------------------------------- watchShared

const until = async (ok: () => boolean, ms = 2_000) => {
  for (let t = 0; t < ms && !ok(); t += 25)
    await new Promise((r) => setTimeout(r, 25));
  return ok();
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("watchShared logs a write the daemon did not make, once, and skips .ff- names, temp files and the daemon's own writes", async (t) => {
  const folder = path.join(tmp(t), "players");
  fs.mkdirSync(path.join(folder, "sub"), { recursive: true });
  await wait(300); // macOS reports the folders' own creation to a watch started right after it
  const lines: string[] = [];
  let busy = true;
  const stop = watchShared(
    [folder, path.join(folder, "missing")],
    (l) => lines.push(l),
    { daemonBusy: () => busy },
  );
  t.after(stop);
  // The daemon's own write, a .ff- name, a temp file and a lock: no line.
  put(path.join(folder, "while-busy.txt"));
  await wait(350); // the events of the busy write arrive while it is busy and are dropped
  busy = false;
  put(path.join(folder, ".ff-thing"));
  put(path.join(folder, "x.tmp"));
  put(path.join(folder, "x.lock"));
  put(path.join(folder, "pool.lock"));
  await wait(350);
  assert.equal(lines.length, 0, lines.join("\n"));
  // A worker's write: one line naming it, once however many events it makes.
  put(path.join(folder, "planted.txt"), "a");
  assert.ok(
    await until(() => lines.some((l) => l.includes("planted.txt"))),
    "a line within 2 s",
  );
  fs.appendFileSync(path.join(folder, "planted.txt"), "b");
  put(path.join(folder, "other.txt"));
  assert.ok(await until(() => lines.some((l) => l.includes("other.txt"))));
  assert.equal(lines.filter((l) => l.includes("planted.txt")).length, 1);
  assert.match(
    lines.find((l) => l.includes("planted.txt"))!,
    /^shared lock \(warn\): .*planted\.txt changed and the daemon did not write it; .*\(w5615\)$/,
  );
  // The first level below it is watched too.
  put(path.join(folder, "sub", "inner.txt"));
  assert.ok(
    await until(() =>
      lines.some((l) => l.includes(path.join("sub", "inner.txt"))),
    ),
  );
});

test("watchShared: stop closes the watchers", async (t) => {
  const folder = tmp(t);
  const lines: string[] = [];
  const stop = watchShared([folder], (l) => lines.push(l));
  stop();
  put(path.join(folder, "after-stop.txt"));
  await wait(350);
  assert.deepEqual(lines, []);
});

// w6274: macOS delivers the daemon's own events after daemonBusy() went false (m5: slot.json 28 ms after an install).
test("sharedEventHandler: a late event just after the daemon's write is its own; a worker's write after the grace is logged", (t) => {
  const dir = tmp(t);
  put(path.join(dir, "slot.json"));
  put(path.join(dir, "planted.txt"));
  let clock = Date.now();
  const lines: string[] = [];
  const ended = clock; // the install ended now; daemonBusy() is already false
  const on = sharedEventHandler((l) => lines.push(l), {
    daemonBusy: () => false,
    lastDaemonWrite: () => ended,
    now: () => clock,
  });
  clock = ended + 28;
  on(dir, dir, "slot.json");
  clock = ended + DAEMON_GRACE_MS - 1;
  on(dir, dir, "slot.json");
  assert.deepEqual(lines, []);
  clock = ended + DAEMON_GRACE_MS + 1;
  fs.appendFileSync(path.join(dir, "planted.txt"), "y"); // a worker's write: mtime and ctime are now
  on(dir, dir, "planted.txt");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /planted\.txt changed and the daemon did not write it/);
  // A delete after the grace counts too (nothing to stat).
  on(dir, dir, "gone.txt");
  assert.equal(lines.length, 2);
});

test("sharedEventHandler: an event on an entry whose mtime and ctime predate it is no write (a clone's read)", (t) => {
  const dir = tmp(t);
  put(path.join(dir, "INSTALLATION_COMPLETE"));
  const st = fs.statSync(path.join(dir, "INSTALLATION_COMPLETE"));
  let clock = Math.max(st.mtimeMs, st.ctimeMs) + STALE_MS + 1_000;
  const lines: string[] = [];
  const on = sharedEventHandler((l) => lines.push(l), { now: () => clock });
  on(dir, dir, "INSTALLATION_COMPLETE");
  assert.deepEqual(lines, []);
  clock = Math.max(st.mtimeMs, st.ctimeMs) + 50; // just written: logged
  on(dir, dir, "INSTALLATION_COMPLETE");
  assert.equal(lines.length, 1);
});

test("sharedEventHandler: uv's random .tmp names make one line per folder an hour", (t) => {
  const root = tmp(t);
  const builds = path.join(root, "builds-v0");
  const other = path.join(root, "archive-v0");
  let clock = Date.now();
  const lines: string[] = [];
  const on = sharedEventHandler((l) => lines.push(l), { now: () => clock });
  for (const n of [".tmpAbC123", ".tmpZz9_x0", ".tmpQ7w-e1"]) on(builds, root, n);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /\.tmpAbC123 changed .*random \.tmp names in .*builds-v0 make one line an hour/);
  on(other, root, ".tmpLmN456"); // another folder: its own line
  assert.equal(lines.length, 2);
  on(builds, root, "wheel.whl"); // a plain name keeps its own key
  assert.equal(lines.length, 3);
  clock += 3600_001;
  on(builds, root, ".tmpNew999");
  assert.equal(lines.length, 4);
});

test("watchShared: the events of a daemon write that arrive after it ended are not logged; a later worker write is", async (t) => {
  const folder = path.join(tmp(t), "players");
  fs.mkdirSync(folder, { recursive: true });
  await wait(300);
  const lines: string[] = [];
  let busy = false;
  let ended = -Infinity;
  const stop = watchShared([folder], (l) => lines.push(l), {
    daemonBusy: () => busy,
    lastDaemonWrite: () => ended,
    graceMs: 600,
  });
  t.after(stop);
  busy = true;
  put(path.join(folder, "slot.json"));
  busy = false; // ends before its event is delivered, as FSEvents does on macOS
  ended = Date.now();
  await wait(350);
  assert.equal(lines.length, 0, lines.join("\n"));
  await wait(400); // past the grace
  put(path.join(folder, "planted.txt"));
  assert.ok(await until(() => lines.some((l) => l.includes("planted.txt"))));
  assert.ok(!lines.some((l) => l.includes("slot.json")), lines.join("\n"));
});

// ---------------------------------------------------------------- w6284: a half-made clone is completed

test("w6284: a clone whose copies failed is completed cache by cache, after RETRY_MS or retryNow, and says what it made", async (t) => {
  // As on LothDesktop at 02:56Z: the first tick ran before the Low node copies, so every real copy failed.
  let lowReady = false;
  const p = pool(t, [{ id: "slot1", idle: false }, { id: "slot2", idle: false }], {
    copy: async (src, dst) => {
      if (!lowReady)
        throw new Error(
          "no Low node copy to copy with; a worker's files are never copied with the daemon's rights",
        );
      await copyTree(src, dst);
    },
  });
  put(seedDir(p.root, "npm", "_cacache", "content-v2", "blob"), "npm blob");
  const dir = slotCacheDir(p.root, "slot1");
  const first = await p.caches.tick();
  assert.match(first!, /^slot caches: slot1: made from the shared seed/);
  assert.match(first!, /failed: uv \(no Low node copy.*; npm \(no Low node copy/);
  assert.match(first!, /the missing ones are tried again in 60 min/);
  const made = p.clock.t;
  assert.deepEqual(readMarker(dir)!.tools.sort(), SLOT_CACHE_TOOLS.map((x) => x.dir).filter((x) => x !== "uv" && x !== "npm").sort());
  assert.deepEqual(missingSlotCaches(p.root, "slot1").sort(), ["npm", "uv"]);

  // The start line counts it per cache: a marker is not a whole clone.
  const half = sharedLockBlockers(p.root, ["slot1"]);
  assert.deepEqual(half, [
    `sandbox slot1 lacks 2 of its ${SLOT_CACHE_TOOLS.length} cache clones (uv, npm; tried again by the daemon)`,
  ]);
  assert.match(sharedLockLine("warn", half)!, /With "on" it would stay off: sandbox slot1 lacks 2 of its 7 cache clones/);

  // One failing sandbox holds back no other: the next tick goes to slot2 (it fails too, Low copies are not there yet).
  p.clock.t += 600_000;
  assert.match((await p.caches.tick())!, /^slot caches: slot2: made/);
  // Within RETRY_MS nothing is tried again.
  p.clock.t += 600_000;
  assert.equal(await p.caches.tick(), undefined);

  // The daemon makes its Low node copies and calls retryNow: slot1 is completed at once.
  lowReady = true;
  p.caches.retryNow();
  p.clock.t += 1_000;
  const done = await p.caches.tick();
  assert.match(done!, /^slot caches: slot1: completed from the shared seed in [\d.]+ s: made uv, npm; already there: pip, nuget.packages, upm, dotnet, ms-playwright \(7 of 7 caches now, w6284\) \(w5615\)$/);
  assert.equal(fs.readFileSync(path.join(dir, "npm", "_cacache", "content-v2", "blob"), "utf8"), "npm blob");
  assert.ok(fs.existsSync(path.join(dir, "uv", "archive-v0", "seed1", "file")));
  assert.deepEqual(missingSlotCaches(p.root, "slot1"), []);
  assert.equal(readMarker(dir)!.made, made, "completing keeps the first made, so the daily refresh is not put off");
  assert.equal(slotCacheEnv(p.root, "slot1", "warn", "linux").UV_CACHE_DIR, path.join(dir, "uv"));
  assert.deepEqual(sharedLockBlockers(p.root, ["slot1"]), []);

  // slot2, not cleared by retryNow's tick, is due again: it is completed at the next one.
  assert.match((await p.caches.tick())!, /^slot caches: slot2: completed .*made uv, npm/);
  assert.equal(await p.caches.tick(), undefined);
});

test("w6284: without retryNow a failed sandbox is tried again after RETRY_MS; a cache whose folder went is made again", async (t) => {
  let fail = true;
  const p = pool(t, [{ id: "slot1", idle: false }], {
    copy: async (src, dst) => {
      if (fail) throw new Error("boom");
      await copyTree(src, dst);
    },
  });
  await p.caches.tick();
  fail = false;
  p.clock.t += RETRY_MS - 1;
  assert.equal(await p.caches.tick(), undefined);
  p.clock.t += 1;
  assert.match((await p.caches.tick())!, /completed .*made uv;/);
  assert.equal(await p.caches.tick(), undefined);
  // a cache the marker lists but whose folder is gone counts as missing, and is made at the next tick
  const dir = slotCacheDir(p.root, "slot1");
  fs.rmSync(path.join(dir, "pip"), { recursive: true });
  assert.deepEqual(missingSlotCaches(p.root, "slot1"), ["pip"]);
  assert.match(sharedLockBlockers(p.root, ["slot1"])[0], /lacks 1 of its 7 cache clones \(pip;/);
  assert.match((await p.caches.tick())!, /completed .*made pip; already there: uv, npm/);
});
