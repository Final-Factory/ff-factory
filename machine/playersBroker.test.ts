import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { RpcRefused, type Caller } from "./daemonRpc.ts";
import { brokerLauncher, brokerPlayerEnv } from "./playersLaunch.ts";
import {
  AUTOMATION_CONFIG,
  buildKey,
  bundleExe,
  logDirOf,
  playersRpcHandlers,
  splitPlayer,
  type BrokerLaunch,
  type PlayersMarker,
} from "./playersBroker.ts";
import type { PlayerFence } from "./playerFence.ts";
import { FENCED_LAUNCH_SCRIPT } from "./unity.ts";

/**
 * w5615: the players broker (machine/playersBroker.ts) and how the daemon starts a broker player (machine/playersLaunch.ts).
 * A temp worker root with one sandbox folder; copyTree is fs.cpSync, the launch a fake that records what it was asked.
 */

const ME: Caller = { session: "s1", sandbox: "slot3" };

function tmp(t: TestContext): string {
  const d = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "players-broker-"),
  );
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const put = (file: string, text = "x") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/** A Mac build: `<dir>/Game.app/Contents/MacOS/Game` and an Info.plist. Returns the .app. */
function macBuild(dir: string, tag = "one"): string {
  const app = path.join(dir, "Game.app");
  put(path.join(app, "Contents", "MacOS", "Game"), `#!/bin/sh\n# ${tag}\n`);
  put(path.join(app, "Contents", "Info.plist"), "<plist/>");
  return app;
}
/** A Windows build: `<dir>/Game.exe` and `Game_Data/`. Returns the exe. */
function winBuild(dir: string, tag = "one"): string {
  put(path.join(dir, "Game.exe"), `MZ ${tag}`);
  put(path.join(dir, "Game_Data", "data.assets"), tag);
  return path.join(dir, "Game.exe");
}

function broker(
  t: TestContext,
  o: {
    launch?: (
      l: BrokerLaunch,
    ) => Promise<{ pid: number } | { refused: string }>;
    copy?: (s: string, d: string) => Promise<void>;
  } = {},
) {
  const root = tmp(t);
  const sandbox = path.join(root, "sandboxes", "slot3");
  fs.mkdirSync(sandbox, { recursive: true });
  const copies: [string, string][] = [];
  const launches: BrokerLaunch[] = [];
  const log: string[] = [];
  const state = { alive: true };
  let clock = 1_700_000_000_000;
  const h = playersRpcHandlers({
    root,
    host: "hostA",
    sandboxPath: (id) => (id === "slot3" ? sandbox : undefined),
    copyTree:
      o.copy ??
      (async (s, d) => {
        copies.push([s, d]);
        fs.cpSync(s, d, { recursive: true });
      }),
    removeTree: async (d) => fs.rmSync(d, { recursive: true, force: true }),
    launch:
      o.launch ??
      (async (l) => {
        launches.push(l);
        return { pid: process.pid };
      }),
    alive: () => state.alive,
    log: (l) => log.push(l),
    now: () => (clock += 1000),
  });
  const slot = (peer = 0) => path.join(root, "players", `slot3-${peer}`);
  return { root, sandbox, h, copies, launches, log, state, slot };
}

/** What the handler throws, sync or async; undefined when it answers. */
async function refusal(f: () => unknown): Promise<RpcRefused | undefined> {
  try {
    await f();
  } catch (e) {
    assert.ok(e instanceof RpcRefused, `a refusal, not ${(e as Error).stack}`);
    return e;
  }
  return undefined;
}
async function refused(f: () => unknown, status: number, message: RegExp) {
  const e = await refusal(f);
  assert.ok(e, "refused");
  assert.equal(e.status, status, e.message);
  assert.match(e.message, message);
}
const marker = (slot: string) =>
  JSON.parse(
    fs.readFileSync(path.join(slot, "slot.json"), "utf8"),
  ) as PlayersMarker;

// ---------------------------------------------------------------- install

test("install copies a Mac build into the caller's own slot and writes slot.json as the broker's, ready", async (t) => {
  const b = broker(t);
  const app = macBuild(path.join(b.sandbox, "Build"));
  const r = (await b.h["players/install"](ME, {
    player: app,
    sha: "abc123",
  })) as Record<string, unknown>;
  assert.equal(r.slot, "slot3-0");
  assert.equal(r.slotDir, b.slot());
  assert.equal(r.filled, true);
  assert.equal(r.player, path.join(b.slot(), "player", "Game.app"));
  assert.equal(r.build, buildKey(app));
  assert.deepEqual(b.copies, [
    [app, path.join(b.slot(), "player", "Game.app")],
  ]);
  assert.ok(
    fs.existsSync(
      path.join(b.slot(), "player", "Game.app", "Contents", "MacOS", "Game"),
    ),
  );
  const m = marker(b.slot());
  assert.equal(m.broker, true);
  assert.equal(m.state, "ready");
  assert.equal(m.sha, "abc123");
  assert.equal(m.entry, "Game.app");
  assert.equal(m.lands, "Game.app");
  assert.equal(m.source, app);
  assert.equal(m.fingerprint, r.build);
  assert.ok(fs.statSync(path.join(b.slot(), "leases")).isDirectory());
  assert.match(
    b.log.join("\n"),
    /players broker: s1 installed .*into slot3-0 .*\(w5615\)/,
  );
});

test("install copies a Windows build's folder, the runtime files left behind, and peer 1 has its own slot", async (t) => {
  const b = broker(t);
  const exe = winBuild(path.join(b.sandbox, "win"));
  put(path.join(b.sandbox, "win", AUTOMATION_CONFIG), '{"stale":1}');
  put(path.join(b.sandbox, "win", ".ff-local-automation-status.json"), "{}");
  const r = (await b.h["players/install"](ME, {
    player: exe,
    peer: 1,
  })) as Record<string, unknown>;
  assert.equal(r.slot, "slot3-1");
  assert.equal(r.player, path.join(b.slot(1), "player", "Game.exe"));
  assert.ok(
    fs.existsSync(path.join(b.slot(1), "player", "Game_Data", "data.assets")),
  );
  assert.ok(
    !fs.existsSync(path.join(b.slot(1), "player", AUTOMATION_CONFIG)),
    "the runtime files do not travel",
  );
  assert.ok(
    !fs.existsSync(
      path.join(b.slot(1), "player", ".ff-local-automation-status.json"),
    ),
  );
  assert.equal(marker(b.slot(1)).lands, "");
  assert.equal(marker(b.slot(1)).entry, "Game.exe");
  assert.equal(
    fs.existsSync(b.slot(0)),
    false,
    "the other peer's slot is not made",
  );
  // the runtime files are not the build: changing them is the same build
  assert.equal(
    buildKey(path.join(b.sandbox, "win")),
    (r as { build: string }).build,
  );
});

test("install of the same build again reuses the slot (no second copy); a changed build or sha fills again", async (t) => {
  const b = broker(t);
  const app = macBuild(path.join(b.sandbox, "Build"));
  await b.h["players/install"](ME, { player: app, sha: "abc" });
  const again = (await b.h["players/install"](ME, {
    player: app,
    sha: "abc",
  })) as Record<string, unknown>;
  assert.equal(again.filled, false);
  assert.equal(again.player, path.join(b.slot(), "player", "Game.app"));
  assert.equal(b.copies.length, 1);
  // a different sha names a different build
  assert.equal(
    (
      (await b.h["players/install"](ME, { player: app, sha: "def" })) as {
        filled: boolean;
      }
    ).filled,
    true,
  );
  assert.equal(b.copies.length, 2);
  assert.equal(marker(b.slot()).sha, "def");
  // a rebuilt file (size changes) is a different build
  put(
    path.join(app, "Contents", "MacOS", "Game"),
    "a much longer rebuilt executable\n",
  );
  assert.equal(
    (
      (await b.h["players/install"](ME, { player: app, sha: "def" })) as {
        filled: boolean;
      }
    ).filled,
    true,
  );
  assert.equal(b.copies.length, 3);
  assert.equal(
    fs.readFileSync(
      path.join(b.slot(), "player", "Game.app", "Contents", "MacOS", "Game"),
      "utf8",
    ),
    "a much longer rebuilt executable\n",
  );
  assert.deepEqual(
    fs.readdirSync(b.slot()).filter((n) => n.startsWith("trash-")),
    [],
    "the old copy is removed",
  );
});

test("install takes a build from the sandbox, the worker root's tmp or nightly; never players, the daemon's folder or the secrets", async (t) => {
  const b = broker(t);
  const outside = tmp(t);
  for (const dir of ["tmp", "nightly"]) {
    const app = macBuild(path.join(b.root, dir, "run1"));
    assert.equal(
      (
        (await b.h["players/install"](ME, { player: app })) as {
          filled: boolean;
        }
      ).filled,
      true,
      dir,
    );
  }
  for (const dir of [
    path.join(b.root, "players", "slot4-0", "player"),
    path.join(b.root, "daemon", "x"),
    path.join(b.root, "secrets"),
    outside,
    b.root,
  ]) {
    const app = macBuild(dir);
    await refused(
      () => b.h["players/install"](ME, { player: app }),
      403,
      /not in your sandbox, the temp folder or the nightly folder/,
    );
  }
  // a link inside the sandbox to a build in players is followed, not trusted
  const target = macBuild(
    path.join(b.root, "players", "slot4-0", "link-target"),
  );
  const link = path.join(b.sandbox, "Linked.app");
  fs.symlinkSync(target, link);
  await refused(
    () => b.h["players/install"](ME, { player: link }),
    403,
    /not in your sandbox/,
  );
});

test("install refuses a caller with no sandbox (403), a bad peer or player (400) and a missing build (404)", async (t) => {
  const b = broker(t);
  const app = macBuild(path.join(b.sandbox, "Build"));
  await refused(
    () => b.h["players/install"]({ session: "s9" }, { player: app }),
    403,
    /only a sandbox worker/,
  );
  await refused(
    () =>
      b.h["players/install"](
        { session: "s9", sandbox: "../slot3" },
        { player: app },
      ),
    403,
    /only a sandbox worker/,
  );
  await refused(
    () => b.h["players/install"](ME, { player: app, peer: 2 }),
    400,
    /peer is 0 or 1/,
  );
  await refused(
    () => b.h["players/install"](ME, { player: app, peer: "0" }),
    400,
    /peer is 0 or 1/,
  );
  await refused(() => b.h["players/install"](ME, {}), 400, /absolute path/);
  await refused(
    () => b.h["players/install"](ME, { player: "Build/Game.app" }),
    400,
    /absolute path/,
  );
  await refused(
    () =>
      b.h["players/install"](ME, {
        player: path.join(b.sandbox, "Build", "notes.txt"),
      }),
    400,
    /\.exe, \.x86_64 or \.app/,
  );
  await refused(
    () =>
      b.h["players/install"](ME, {
        player: path.join(b.sandbox, "Build", "Gone.app"),
      }),
    404,
    /no player at/,
  );
  await refused(
    () =>
      b.h["players/install"](ME, {
        player: path.join(b.sandbox, "Build", "Gone.exe"),
      }),
    404,
    /no player at/,
  );
  assert.equal(b.copies.length, 0);
  assert.equal(fs.existsSync(path.join(b.root, "players")), false);
});

test("install while a live lease holds the slot is refused (409); once its process is gone it goes through", async (t) => {
  const b = broker(t);
  const first = macBuild(path.join(b.sandbox, "A"));
  const second = macBuild(path.join(b.sandbox, "B"), "a different build");
  await b.h["players/install"](ME, { player: first });
  await b.h["players/launch"](ME, {});
  await refused(
    () => b.h["players/install"](ME, { player: second }),
    409,
    new RegExp(`holds a running player \\(pid ${process.pid}\\)`),
  );
  assert.equal(b.copies.length, 1);
  // the same build is still reused while it runs: nothing to replace
  assert.equal(
    (
      (await b.h["players/install"](ME, { player: first })) as {
        filled: boolean;
      }
    ).filled,
    false,
  );
  // a lease from another computer cannot be checked here and counts as live
  put(
    path.join(b.slot(), "leases", "elsewhere.json"),
    JSON.stringify({ pid: 4242, host: "hostB", session: "sx" }),
  );
  b.state.alive = false;
  await refused(
    () => b.h["players/install"](ME, { player: second }),
    409,
    /pid 4242/,
  );
  fs.rmSync(path.join(b.slot(), "leases", "elsewhere.json"));
  assert.equal(
    (
      (await b.h["players/install"](ME, { player: second })) as {
        filled: boolean;
      }
    ).filled,
    true,
  );
  // the other peer's slot was never in the way
  b.state.alive = true;
  assert.equal(
    (
      (await b.h["players/install"](ME, { player: second, peer: 1 })) as {
        filled: boolean;
      }
    ).filled,
    true,
  );
});

test("install whose copy fails answers 500 and leaves no half-filled slot behind", async (t) => {
  const b = broker(t, {
    copy: async (_s, d) => {
      fs.mkdirSync(d, { recursive: true });
      put(path.join(d, "half"));
      throw new Error("disk full\nmore");
    },
  });
  const app = macBuild(path.join(b.sandbox, "Build"));
  await refused(
    () => b.h["players/install"](ME, { player: app }),
    500,
    /copying .* into slot3-0 failed: disk full$/,
  );
  assert.equal(fs.existsSync(path.join(b.slot(), "slot.json")), false);
  assert.equal(fs.existsSync(path.join(b.slot(), "player")), false);
  await refused(
    () => b.h["players/launch"](ME, {}),
    409,
    /players\/install first/,
  );
});

// ---------------------------------------------------------------- launch

test("launch before install is refused (409), and one onto a slot the broker did not fill", async (t) => {
  const b = broker(t);
  await refused(
    () => b.h["players/launch"](ME, {}),
    409,
    /holds no build the broker installed; players\/install first/,
  );
  put(
    path.join(b.slot(), "slot.json"),
    JSON.stringify({ sha: "x", state: "ready", entry: "Game.app" }),
  ); // player_slots.py's own
  await refused(
    () => b.h["players/launch"](ME, {}),
    409,
    /holds no build the broker installed/,
  );
  await refused(
    () => b.h["players/launch"]({ session: "s9" }, {}),
    403,
    /only a sandbox worker/,
  );
  await refused(
    () => b.h["players/launch"](ME, { peer: 3 }),
    400,
    /peer is 0 or 1/,
  );
  assert.equal(b.launches.length, 0);
});

test("launch refuses bad args and a bad config (400) without starting anything", async (t) => {
  const b = broker(t);
  await b.h["players/install"](ME, {
    player: macBuild(path.join(b.sandbox, "Build")),
  });
  const bad: unknown[] = [
    "-x",
    [1],
    [null],
    [["a"]],
    ["ok", "a\0b"],
    ["x".repeat(4097)],
    Array.from({ length: 201 }, () => "a"),
    {},
  ];
  for (const args of bad)
    await refused(
      () => b.h["players/launch"](ME, { args }),
      400,
      /args is a list of at most 200 strings/,
    );
  for (const config of [5, {}, "not json", "{", "x".repeat(256 * 1024 + 1)])
    await refused(
      () => b.h["players/launch"](ME, { config }),
      400,
      /config is/,
    );
  assert.equal(b.launches.length, 0);
  assert.equal(
    fs.existsSync(path.join(b.slot(), "player", "Game.app", AUTOMATION_CONFIG)),
    false,
  );
  // the limits themselves are fine
  await b.h["players/launch"](ME, {
    args: Array.from({ length: 200 }, () => "x".repeat(4096)),
  });
  assert.equal(b.launches.length, 1);
});

test("launch of a Mac build starts the bundle's executable and writes the automation config beside the .app; none removes it", async (t) => {
  const b = broker(t);
  await b.h["players/install"](ME, {
    player: macBuild(path.join(b.sandbox, "Build")),
    sha: "s",
  });
  const cfgFile = path.join(b.slot(), "player", "Game.app", AUTOMATION_CONFIG);
  const r = (await b.h["players/launch"](ME, {
    args: ["-batchmode", "-x"],
    config: '{"role":"host"}',
  })) as Record<string, unknown>;
  const exe = path.join(
    b.slot(),
    "player",
    "Game.app",
    "Contents",
    "MacOS",
    "Game",
  );
  assert.deepEqual(b.launches, [
    {
      exe,
      args: ["-batchmode", "-x"],
      cwd: path.dirname(exe),
      slotDir: b.slot(),
      sandbox: "slot3",
      session: "s1",
    },
  ]);
  assert.equal(fs.readFileSync(cfgFile, "utf8"), '{"role":"host"}');
  assert.equal(r.pid, process.pid);
  assert.equal(r.exe, exe);
  assert.equal(r.slot, "slot3-0");
  assert.equal(r.build, marker(b.slot()).fingerprint);
  // a launch without a config takes the stale one away, so the player does not start as the last run's role
  await b.h["players/launch"](ME, {});
  assert.equal(fs.existsSync(cfgFile), false);
  assert.deepEqual(b.launches[1].args, []);
});

test("launch of a Windows build puts the config beside the exe", async (t) => {
  const b = broker(t);
  await b.h["players/install"](ME, {
    player: winBuild(path.join(b.sandbox, "win")),
  });
  await b.h["players/launch"](ME, {
    config: '{"a":1}',
    args: ["-popupwindow"],
  });
  const exe = path.join(b.slot(), "player", "Game.exe");
  assert.equal(b.launches[0].exe, exe);
  assert.equal(b.launches[0].cwd, path.dirname(exe));
  assert.equal(
    fs.readFileSync(path.join(b.slot(), "player", AUTOMATION_CONFIG), "utf8"),
    '{"a":1}',
  );
  await b.h["players/launch"](ME, {});
  assert.equal(
    fs.existsSync(path.join(b.slot(), "player", AUTOMATION_CONFIG)),
    false,
  );
});

test("launch writes a lease with the session and pid under the slot's leases and answers its path; status shows it", async (t) => {
  const b = broker(t);
  await b.h["players/install"](ME, {
    player: macBuild(path.join(b.sandbox, "Build")),
    sha: "cafe",
  });
  const r = (await b.h["players/launch"](ME, {})) as {
    lease: string;
    pid: number;
  };
  assert.equal(path.dirname(r.lease), path.join(b.slot(), "leases"));
  assert.match(
    path.basename(r.lease),
    new RegExp(`^hostA-${process.pid}-[0-9a-f]{8}\\.json$`),
  );
  const lease = JSON.parse(fs.readFileSync(r.lease, "utf8"));
  assert.equal(lease.pid, process.pid);
  assert.equal(lease.session, "s1");
  assert.equal(lease.host, "hostA");
  assert.equal(lease.sandbox, b.sandbox);
  assert.equal(lease.sha, "cafe");
  assert.equal(lease.broker, true);
  const st = (await b.h["players/status"](ME, {})) as {
    slots: {
      slot: string;
      dir: string;
      marker: PlayersMarker | null;
      leases: { pid: number; session?: string; host?: string; file: string }[];
    }[];
  };
  assert.deepEqual(
    st.slots.map((s) => s.slot),
    ["slot3-0", "slot3-1"],
  );
  assert.equal(st.slots[0].dir, b.slot());
  assert.equal(st.slots[0].marker?.state, "ready");
  assert.deepEqual(st.slots[0].leases, [
    {
      file: path.basename(r.lease),
      pid: process.pid,
      session: "s1",
      host: "hostA",
    },
  ]);
  assert.equal(st.slots[1].marker, null);
  assert.deepEqual(st.slots[1].leases, []);
  // a lease whose process is gone is dead and not listed
  b.state.alive = false;
  const dead = (await b.h["players/status"](ME, {})) as {
    slots: { leases: unknown[] }[];
  };
  assert.deepEqual(dead.slots[0].leases, []);
  await refused(
    () => b.h["players/status"]({ session: "s9" }, {}),
    403,
    /only a sandbox worker/,
  );
  assert.match(
    b.log.join("\n"),
    /players broker: s1 started .*Game in slot3-0 as pid \d+ \(w5615\)/,
  );
});

test("a launch the fence refuses is answered 503 with its reason, and leaves no lease", async (t) => {
  const b = broker(t, {
    launch: async () => ({ refused: "the player fence cannot run here (x)" }),
  });
  await b.h["players/install"](ME, {
    player: macBuild(path.join(b.sandbox, "Build")),
  });
  await refused(
    () => b.h["players/launch"](ME, {}),
    503,
    /^players\/launch: the player fence cannot run here \(x\)$/,
  );
  assert.deepEqual(fs.readdirSync(path.join(b.slot(), "leases")), []);
});

test("launch says to install again when the player folder is gone, and a bundle with no single executable is refused", async (t) => {
  const b = broker(t);
  await b.h["players/install"](ME, {
    player: macBuild(path.join(b.sandbox, "Build")),
  });
  put(path.join(b.slot(), "player", "Game.app", "Contents", "MacOS", "Second"));
  await refused(
    () => b.h["players/launch"](ME, {}),
    409,
    /holds 2 files, not one executable/,
  );
  fs.rmSync(path.join(b.slot(), "player"), { recursive: true });
  await refused(
    () => b.h["players/launch"](ME, {}),
    409,
    /is gone; players\/install again/,
  );
  assert.equal(b.launches.length, 0);
});

// ---------------------------------------------------------------- release

test("release: the caller's own lease goes; another session's is refused (403); an unknown one is no lease", async (t) => {
  const b = broker(t);
  await b.h["players/install"](ME, {
    player: macBuild(path.join(b.sandbox, "Build")),
  });
  const { lease } = (await b.h["players/launch"](ME, {})) as { lease: string };
  await refused(
    () =>
      b.h["players/release"]({ session: "s2", sandbox: "slot3" }, { lease }),
    403,
    /another session holds that lease/,
  );
  assert.ok(fs.existsSync(lease));
  // another sandbox reaches only its own slots, so this lease is not found there
  assert.deepEqual(
    await b.h["players/release"](
      { session: "s1", sandbox: "slot4" },
      { lease },
    ),
    { had: false },
  );
  assert.ok(fs.existsSync(lease));
  await refused(
    () => b.h["players/release"]({ session: "s1" }, { lease }),
    403,
    /only a sandbox worker/,
  );
  await refused(() => b.h["players/release"](ME, {}), 400, /lease is the path/);
  await refused(
    () => b.h["players/release"](ME, { lease: 7 }),
    400,
    /lease is the path/,
  );
  // a path that only ends in the same file name is not that lease
  assert.deepEqual(
    await b.h["players/release"](ME, {
      lease: path.join(b.sandbox, path.basename(lease)),
    }),
    { had: false },
  );
  assert.ok(fs.existsSync(lease));
  assert.deepEqual(await b.h["players/release"](ME, { lease }), { had: true });
  assert.equal(fs.existsSync(lease), false);
  assert.deepEqual(await b.h["players/release"](ME, { lease }), { had: false });
  // with the lease gone the slot can be refilled
  assert.equal(
    (
      (await b.h["players/install"](ME, {
        player: macBuild(path.join(b.sandbox, "B"), "other"),
      })) as { filled: boolean }
    ).filled,
    true,
  );
});

// ---------------------------------------------------------------- helpers

test("splitPlayer and bundleExe: what a player path means", (t) => {
  assert.deepEqual(splitPlayer("/b/Game.app/"), {
    src: "/b/Game.app",
    lands: "Game.app",
    entry: "Game.app",
  });
  assert.deepEqual(splitPlayer("/b/win/Game.EXE"), {
    src: "/b/win",
    lands: "",
    entry: "Game.EXE",
  });
  assert.deepEqual(splitPlayer("/b/lin/Game.x86_64"), {
    src: "/b/lin",
    lands: "",
    entry: "Game.x86_64",
  });
  assert.throws(
    () => splitPlayer("/b/Game"),
    (e: unknown) => e instanceof RpcRefused && e.status === 400,
  );
  const app = macBuild(tmp(t));
  assert.equal(bundleExe(app), path.join(app, "Contents", "MacOS", "Game"));
  put(path.join(app, "Contents", "MacOS", ".DS_Store"));
  assert.equal(
    bundleExe(app),
    path.join(app, "Contents", "MacOS", "Game"),
    "a dot file is not the executable",
  );
});

// ---------------------------------------------------------------- playersLaunch.ts: the daemon starts the player

const ghToken = "ghp_" + "a1B2c3D4e5".repeat(3) + "a1B2c3";
const launchOf = (
  root: string,
  over: Partial<BrokerLaunch> = {},
): BrokerLaunch => {
  const slotDir = path.join(root, "players", "slot3-0");
  const cwd = path.join(slotDir, "player");
  return {
    exe: path.join(cwd, "Game.exe"),
    args: ["-a", "b c"],
    cwd,
    slotDir,
    sandbox: "slot3",
    session: "s1",
    ...over,
  };
};

test("brokerPlayerEnv drops credentials and names the session, the sandbox and the broker", () => {
  assert.equal(ghToken.length, 40);
  const env = brokerPlayerEnv(
    {
      PATH: "/bin",
      HOME: "/h",
      DISPLAY: ":0",
      GH_TOKEN: ghToken,
      ANTHROPIC_API_KEY: "sk-ant-api03-whatever",
      AWS_SECRET: "x",
      UNRELATED: "y",
      FF_GAME_DATA_DIR: "/w/gamedata",
    },
    launchOf("/w"),
    undefined,
    "linux",
  );
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.AWS_SECRET, undefined);
  assert.equal(env.UNRELATED, undefined, "only what a player needs is kept");
  assert.equal(env.FF_SESSION_ID, "s1");
  assert.equal(env.FF_SANDBOX_ID, "slot3");
  assert.equal(env.FF_PLAYER_BROKER, "1");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/h");
  assert.equal(env.DISPLAY, ":0");
  assert.equal(
    env.FF_GAME_DATA_DIR,
    path.join("/w/gamedata", "sandboxes", "slot3"),
    "the sandbox's own data root",
  );
  assert.ok(!Object.values(env).some((v) => v.includes("ghp_")));
});

test("brokerPlayerEnv: a token-shaped value under a kept name is dropped too", () => {
  const env = brokerPlayerEnv(
    { PATH: "/bin", DISPLAY: ghToken },
    launchOf("/w"),
    undefined,
    "linux",
  );
  assert.equal(env.DISPLAY, undefined);
  assert.equal(env.PATH, "/bin");
});

test("brokerLauncher on Windows with no Low node copy refuses and starts nothing", async (t) => {
  const root = tmp(t);
  let started = 0;
  const go = brokerLauncher({
    root,
    platform: "win32",
    playerFence: () => ({ kind: "none" }),
    lowNode: () => undefined,
    base: { PATH: "p" },
    start: async () => ++started,
  });
  const r = await go(launchOf(root));
  assert.ok("refused" in r);
  assert.match(r.refused, /no Low node copy to start it with/);
  assert.equal(started, 0);
});

test("brokerLauncher on Windows starts the Low node with -e, the fenced launch script, the exe, cwd and args", async (t) => {
  const root = tmp(t);
  const calls: {
    cmd: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  }[] = [];
  const go = brokerLauncher({
    root,
    platform: "win32",
    playerFence: () => ({ kind: "none" }),
    lowNode: () => "C:\\low\\node.exe",
    base: { PATH: "p", GH_TOKEN: ghToken },
    start: async (cmd, args, cwd, env) => (
      calls.push({ cmd, args, cwd, env }),
      4321
    ),
  });
  const l = launchOf(root);
  assert.deepEqual(await go(l), { pid: 4321 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "C:\\low\\node.exe");
  assert.deepEqual(calls[0].args, [
    "-e",
    FENCED_LAUNCH_SCRIPT,
    l.exe,
    l.cwd,
    JSON.stringify(l.args),
  ]);
  assert.equal(calls[0].cwd, l.cwd);
  assert.equal(calls[0].env.FF_PLAYER_BROKER, "1");
  assert.equal(calls[0].env.GH_TOKEN, undefined);
});

test("brokerLauncher on Linux with the player fence unavailable refuses with its reason", async (t) => {
  const root = tmp(t);
  let started = 0;
  const fence: PlayerFence = { kind: "unavailable", why: "x" };
  const go = brokerLauncher({
    root,
    platform: "linux",
    playerFence: () => fence,
    base: { PATH: "p" },
    start: async () => ++started,
  });
  const r = await go(launchOf(root));
  assert.ok("refused" in r);
  assert.match(
    r.refused,
    /the player fence cannot run here \(x\); a daemon-started player never runs unfenced/,
  );
  assert.equal(started, 0);
});

test("brokerLauncher with no fence (kind none) starts the exe itself, in the slot, with the player env", async (t) => {
  const root = tmp(t);
  const calls: {
    cmd: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  }[] = [];
  const go = brokerLauncher({
    root,
    platform: "darwin",
    playerFence: () => ({ kind: "none" }),
    base: { PATH: "p", HOME: "/h", GH_TOKEN: ghToken },
    start: async (cmd, args, cwd, env) => (
      calls.push({ cmd, args, cwd, env }),
      77
    ),
  });
  const l = launchOf(root, {
    exe: path.join(
      root,
      "players",
      "slot3-0",
      "player",
      "Game.app",
      "Contents",
      "MacOS",
      "Game",
    ),
  });
  assert.deepEqual(await go(l), { pid: 77 });
  assert.equal(calls[0].cmd, l.exe);
  assert.deepEqual(calls[0].args, l.args);
  assert.equal(calls[0].cwd, l.cwd);
  assert.equal(calls[0].env.FF_SESSION_ID, "s1");
  assert.equal(calls[0].env.GH_TOKEN, undefined);
});

test("brokerLauncher under a Landlock fence runs the exe through the wrapper writing only the slot and build folders", async (t) => {
  const root = fs.realpathSync(tmp(t));
  const calls: { cmd: string; args: string[] }[] = [];
  const go = brokerLauncher({
    root,
    platform: "linux",
    playerFence: () => ({
      kind: "landlock",
      python: "/usr/bin/python3",
      script: "/w/ff-landlock.py",
    }),
    base: { PATH: "p" },
    start: async (cmd, args) => (calls.push({ cmd, args }), 9),
  });
  const l = launchOf(root);
  assert.deepEqual(await go(l), { pid: 9 });
  assert.equal(calls[0].cmd, "/usr/bin/python3");
  const a = calls[0].args;
  assert.equal(a[0], "/w/ff-landlock.py");
  const rw = a.flatMap((x, i) => (x === "--rw" ? [a[i + 1]] : []));
  assert.ok(rw.includes(l.slotDir));
  assert.ok(rw.includes(l.cwd));
  assert.ok(!rw.includes(root), "never the worker root itself");
  assert.deepEqual(a.slice(a.indexOf("--")), ["--", l.exe, ...l.args]);
});

test("brokerLauncher: a start that throws is a refusal with the reason", async (t) => {
  const root = tmp(t);
  const go = brokerLauncher({
    root,
    platform: "darwin",
    playerFence: () => ({ kind: "none" }),
    base: { PATH: "p" },
    start: async () => {
      throw new Error("spawn ENOEXEC");
    },
  });
  assert.deepEqual(await go(launchOf(root)), {
    refused: "could not start it: spawn ENOEXEC",
  });
});

test("w5615: logDirOf opens a -logFile folder only inside <root>/tmp", () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "logdir-")),
  );
  fs.mkdirSync(path.join(root, "tmp", "ffa-1"), { recursive: true });
  assert.deepEqual(
    logDirOf(["-logFile", path.join(root, "tmp", "ffa-1", "p.log")], root),
    { logDir: path.join(root, "tmp", "ffa-1") },
  );
  assert.deepEqual(
    logDirOf(["-logFile", path.join(root, "tmp", "p.log")], root),
    {},
  );
  assert.deepEqual(
    logDirOf(["-logFile", path.join(root, "daemon", "p.log")], root),
    {},
  );
  assert.deepEqual(logDirOf(["-logFile", "rel.log"], root), {});
  assert.deepEqual(logDirOf([], root), {});
  fs.rmSync(root, { recursive: true, force: true });
});
