import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Daemon, type Probes } from "../machine/daemon.ts";
import {
  ensureDaemonOnlyDirs,
  readFenceMode,
  writeReadFenceMode,
  type ReadFenceMode,
} from "../machine/readFence.ts";
import {
  NO_READ_UP,
  READ_BACK,
  labelNoReadUp,
  type Exec,
} from "../machine/lowIntegrity.ts";

const PROBES: Probes = {
  stats: async () => ({
    hostname: "x",
    platform: process.platform,
    cpuCount: 1,
    cpuModel: "x",
    loadPct: 0,
    memTotalBytes: 1,
    memFreeBytes: 1,
  }),
  usage: async () => ({ account: {}, reply: { rate_limits_available: false } }),
};

type Pass = (exec: Exec, say: (l: string) => void) => Promise<void>;
type Apply = (
  mode: ReadFenceMode,
  exec: Exec,
  say: (l: string) => void,
  still: () => boolean,
) => Promise<void>;

function daemonIn(dir: string) {
  const appDir = path.join(dir, "daemon");
  fs.mkdirSync(appDir, { recursive: true });
  const d = new Daemon(
    {
      portalUrl: "http://127.0.0.1:1",
      id: "winbox",
      token: "t",
      repoPath: path.join(dir, "FinalFactory"),
      appDir,
      root: dir,
      maxEventsFile: null,
    },
    () => {
      throw new Error("no agents in this test");
    },
    PROBES,
  );
  return {
    d,
    appDir,
    inTurn: (
      d as unknown as { applyReadLabelsInTurn: Pass }
    ).applyReadLabelsInTurn.bind(d),
  };
}

const noExec: Exec = async () => ({ code: 0, stdout: "", stderr: "" });

test("w5980: a switch to warn during a slow on pass waits for it, the on pass stops early, and warn is the last labels set", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-w5980-"));
  try {
    const { d, appDir, inTurn } = daemonIn(dir);
    const ran: string[] = [];
    let running = 0;
    let release!: () => void;
    const onHeld = new Promise<void>((r) => (release = r));
    (d as unknown as { applyReadLabels: Apply }).applyReadLabels = async (
      mode,
      _e,
      _s,
      still,
    ) => {
      running++;
      assert.equal(running, 1, "two label passes ran side by side");
      ran.push(`start ${mode}`);
      if (mode === "on") {
        await onHeld; // on's WRITE_OWNER grants walking the daemon's folder
        ran.push(still() ? "on: closed the rest" : "on: stopped");
      }
      ran.push(`end ${mode}`);
      running--;
    };
    writeReadFenceMode(appDir, "on");
    const on = inTurn(noExec, () => {});
    await new Promise((r) => setImmediate(r));
    writeReadFenceMode(appDir, "warn");
    const warn = inTurn(noExec, () => {});
    release();
    await Promise.all([on, warn]);
    assert.deepEqual(ran.slice(0, 4), [
      "start on",
      "on: stopped",
      "end on",
      "start warn",
    ]);
    assert.equal(
      ran[ran.length - 1],
      "end warn",
      "the last pass set the warn labels",
    );
    assert.ok(!ran.includes("on: closed the rest"));
    assert.equal(readFenceMode(appDir), "warn");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("w5980: a pass that fails is said to its caller and does not stop the next one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-w5980-"));
  try {
    const { d, appDir, inTurn } = daemonIn(dir);
    const modes: string[] = [];
    let fail = true;
    (d as unknown as { applyReadLabels: Apply }).applyReadLabels = async (
      mode,
    ) => {
      modes.push(mode);
      if (fail) {
        fail = false;
        throw new Error("not every read label could be set");
      }
    };
    writeReadFenceMode(appDir, "on");
    await assert.rejects(
      inTurn(noExec, () => {}),
      /not every read label/,
    );
    writeReadFenceMode(appDir, "off");
    await inTurn(noExec, () => {});
    assert.deepEqual(modes, ["on", "off"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("w5980: a pass whose mode changed while it failed runs again for the new mode and does not throw the old failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-w5980-"));
  try {
    const { d, appDir, inTurn } = daemonIn(dir);
    const modes: string[] = [];
    (d as unknown as { applyReadLabels: Apply }).applyReadLabels = async (
      mode,
    ) => {
      modes.push(mode);
      if (mode === "on") {
        writeReadFenceMode(appDir, "warn");
        throw new Error("not every read label could be set");
      }
    };
    writeReadFenceMode(appDir, "on");
    const said: string[] = [];
    await inTurn(noExec, (l) => void said.push(l));
    assert.deepEqual(modes, ["on", "warn"]);
    assert.ok(
      said.some((l) => l.includes("turned warn while its on labels were set")),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("w5980: labelNoReadUp sets the given-back paths before the closed folders that hold them", async () => {
  const t = [
    { path: "D:\\ffw\\daemon", sddl: NO_READ_UP.dir },
    { path: "D:\\ffw\\daemon\\app", sddl: READ_BACK.dir },
    { path: "D:\\ffw\\root.json", sddl: NO_READ_UP.file },
    { path: "D:\\ffw\\daemon\\sandboxes.json", sddl: READ_BACK.file },
  ];
  let script = "";
  const exec: Exec = async (cmd, args) => {
    if (cmd === "icacls") return { code: 0, stdout: "", stderr: "" };
    script = Buffer.from(args[args.length - 1], "base64").toString("utf16le");
    const n = (script.match(/\[FfLabel\]::Set\(/g) ?? []).length;
    return {
      code: 0,
      stdout: Array.from({ length: n }, (_, i) => `ok ${i}`).join("\r\n"),
      stderr: "",
    };
  };
  assert.equal(
    await labelNoReadUp(t, exec, () => {}, { systemDrive: () => false }),
    true,
  );
  const order = [...script.matchAll(/\[FfLabel\]::Set\('([^']+)'/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(order, [
    "D:\\ffw\\daemon\\app",
    "D:\\ffw\\daemon\\sandboxes.json",
    "D:\\ffw\\daemon",
    "D:\\ffw\\root.json",
  ]);
});

// ---- w6120: the real applyReadLabels and labelNoReadUp, with only icacls and PowerShell faked ----

// The grant needs an account (currentAccount reads USERNAME, which Linux and macOS may not set).
process.env.USERNAME ??= "ffw-test";

type Call = {
  kind: "survey" | "grant" | "label" | "walk";
  paths: string[];
  stop?: { file: string; want: string };
};

/**
 * A fake Windows: icacls answers each path's label from `labels`; a label run sets each label, or answers 5 (access
 * denied) for a path in `denied` until its grant; the walk inside answers `walk` (default done). `onCall` runs inside each
 * call, before its answer, as a switch arriving while that step runs; `onSet` inside a label run after each Set. A label
 * run with a stop file reads it before each closing Set, as the script does, and answers `stopped` from then on.
 */
function fakeWindows(
  o: {
    denied?: Set<string>;
    onCall?: (c: Call) => void;
    onSet?: (path: string) => void;
    walk?: (c: Call) => string;
  } = {},
) {
  const labels = new Map<string, string>();
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args) => {
    let c: Call;
    let out = "";
    if (cmd === "icacls" && args[1] === "/grant") {
      c = { kind: "grant", paths: [args[0]] };
      o.denied?.delete(args[0]);
    } else if (cmd === "icacls") {
      c = { kind: "survey", paths: [args[0]] };
      const l = labels.get(args[0]);
      if (l)
        out = `${args[0]} Mandatory Label\\Medium Mandatory Level:(NW)${l.includes("NWNR") ? "(NR)" : ""}\r\n`;
    } else {
      const script = Buffer.from(args[args.length - 1], "base64").toString(
        "utf16le",
      );
      const walk =
        /\[FfWalk\]::Run\(.*, \$(?:true|false), '([^']*)', '([^']*)'\)$/.exec(
          script,
        );
      if (walk) {
        c = { kind: "walk", paths: [], stop: { file: walk[1], want: walk[2] } };
        calls.push(c);
        o.onCall?.(c);
        return { code: 0, stdout: o.walk?.(c) ?? "done 9 0 0", stderr: "" };
      }
      const sets = [
        ...script.matchAll(/\[FfLabel\]::Set\('([^']+)', '([^']+)'\)/g),
      ].map((m) => [m[1], m[2]] as const);
      c = { kind: "label", paths: sets.map(([p]) => p) };
      const stopFile = /ReadAllText\('([^']+)'\)\.Trim\(\) -eq '([^']+)'/.exec(
        script,
      );
      let stopped = false;
      out = sets
        .map(([p, s], i) => {
          if (stopFile && script.includes(`'stopped ${i}'`)) {
            let m = "";
            try {
              m = fs.readFileSync(stopFile[1], "utf8").trim();
            } catch {}
            if (stopped || m !== stopFile[2]) {
              stopped = true;
              return `stopped ${i}`;
            }
          }
          if (o.denied?.has(p)) return `err ${i} 5`;
          labels.set(p, s);
          o.onSet?.(p);
          return `ok ${i}`;
        })
        .join("\r\n");
    }
    calls.push(c);
    o.onCall?.(c);
    return { code: 0, stdout: out, stderr: "" };
  };
  return { exec, calls, labels };
}

const closes = (sddl: string | undefined) => !!sddl?.includes("NWNR");

/** The daemon with its real applyReadLabels; nothing counts as the system drive (the test's temp folder may be on it). */
function realPass(dir: string) {
  const r = daemonIn(dir);
  Object.defineProperty(r.d, "labelSystemDrive", { get: () => () => false });
  const apply = (
    r.d as unknown as { applyReadLabels: Apply }
  ).applyReadLabels.bind(r.d);
  // As the pass does before it reads its targets (a folder made here changes their kind).
  ensureDaemonOnlyDirs(dir);
  const targets = (
    r.d as unknown as {
      readLabelTargets: (a: string) => { path: string; sddl: string }[];
    }
  ).readLabelTargets(r.appDir);
  const sddlOf = new Map(targets.map((t) => [t.path, t.sddl]));
  /** Whether every label run set the given-back paths before the closed ones. */
  const givenBackFirst = (calls: Call[]) =>
    calls
      .filter((c) => c.kind === "label")
      .every((c) => {
        const k = c.paths.map((p) => closes(sddlOf.get(p)));
        return k.every((x, i) => i === 0 || !k[i - 1] || x);
      });
  return { ...r, apply, targets, sddlOf, givenBackFirst };
}

test("w6120: a switch during on's label run stops the pass at its real step: no walk inside, and no failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-w6120-"));
  try {
    const { appDir, apply, targets } = realPass(dir);
    assert.ok(
      targets.some((t) => closes(t.sddl)) &&
        targets.some((t) => !closes(t.sddl)),
      "the daemon has closed and given-back targets",
    );
    writeReadFenceMode(appDir, "on");
    let flipped = false;
    const w = fakeWindows({
      onCall: (c) => {
        if (c.kind === "label" && !flipped) {
          flipped = true;
          writeReadFenceMode(appDir, "off");
        }
      },
    });
    const said: string[] = [];
    await apply(
      "on",
      w.exec,
      (l) => void said.push(l),
      () => readFenceMode(appDir) === "on",
    );
    assert.ok(
      !w.calls.some((c) => c.kind === "walk"),
      "the walk inside the closed folders did not start",
    );
    assert.ok(
      said.some((l) => l.includes("stopped part way")),
      said.join("\n"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("w6120: on's label run stops between its Sets: the given-backs are all set, the closed ones after the switch are not", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-w6120-"));
  try {
    const { appDir, apply, targets } = realPass(dir);
    const closed = targets.filter((t) => closes(t.sddl)).map((t) => t.path);
    const back = targets.filter((t) => !closes(t.sddl)).map((t) => t.path);
    assert.ok(closed.length >= 2, "at least two closed targets");
    writeReadFenceMode(appDir, "on");
    // The switch to off lands while the first closed Set walks its folder.
    const w = fakeWindows({
      onSet: (p) => {
        if (p === closed[0]) writeReadFenceMode(appDir, "off");
      },
    });
    const said: string[] = [];
    await apply(
      "on",
      w.exec,
      (l) => void said.push(l),
      () => readFenceMode(appDir) === "on",
    );
    const runs = w.calls.filter((c) => c.kind === "label");
    assert.equal(runs.length, 1);
    for (const p of back) assert.ok(w.labels.has(p), `given back: ${p}`);
    assert.deepEqual(
      closed.filter((p) => w.labels.has(p)),
      [closed[0]],
      "only the Set under way when the switch came",
    );
    assert.ok(!w.calls.some((c) => c.kind === "walk"), "no walk inside");
    assert.ok(
      said.some((l) =>
        l.includes(
          `the read fence changed during the label run: ${closed.length - 1} closed path(s)`,
        ),
      ),
      said.join("\n"),
    );
    // And the pass that follows (off) opens that one again.
    writeReadFenceMode(appDir, "off");
    await apply(
      "off",
      w.exec,
      () => {},
      () => readFenceMode(appDir) === "off",
    );
    assert.ok(
      closed.every((p) => !closes(w.labels.get(p))),
      "off left no No-Read-Up",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("w6120: the walk inside is given the mode file and stops when it changes; the pass then stops without failing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-w6120-"));
  try {
    const { appDir, apply } = realPass(dir);
    writeReadFenceMode(appDir, "on");
    // As the C# does: it reads the file every 256 paths, and here the switch lands during the walk.
    const w = fakeWindows({
      walk: (c) => {
        writeReadFenceMode(appDir, "warn");
        return fs.readFileSync(c.stop!.file, "utf8").trim() === c.stop!.want
          ? "done 9 0 0"
          : "stopped 0\r\ndone 0 0 0";
      },
    });
    const said: string[] = [];
    await apply(
      "on",
      w.exec,
      (l) => void said.push(l),
      () => readFenceMode(appDir) === "on",
    );
    const walk = w.calls.find((c) => c.kind === "walk")!;
    assert.deepEqual(walk.stop, {
      file: path.join(appDir, "read-fence"),
      want: "on",
    });
    assert.ok(
      said.some((l) =>
        l.includes("changed during the walk inside the closed folders"),
      ),
      said.join("\n"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("w6120: warn and off always run to the end, whatever the mode file says meanwhile", async () => {
  for (const mode of ["warn", "off"] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-w6120-"));
    try {
      const { appDir, apply, targets } = realPass(dir);
      const closed = targets.filter((t) => closes(t.sddl)).map((t) => t.path);
      writeReadFenceMode(appDir, mode);
      const w = fakeWindows({ onCall: () => writeReadFenceMode(appDir, "on") });
      for (const p of closed) w.labels.set(p, NO_READ_UP.dir); // an earlier on's labels
      await apply(
        mode,
        w.exec,
        () => {},
        () => readFenceMode(appDir) === mode,
      );
      const runs = w.calls.filter((c) => c.kind === "label");
      assert.deepEqual(
        runs.flatMap((c) => c.paths).sort(),
        [...closed].sort(),
        `${mode}: every closed path opened`,
      );
      assert.ok(
        closed.every((p) => !closes(w.labels.get(p))),
        `${mode}: no No-Read-Up left`,
      );
      const walk = w.calls.find((c) => c.kind === "walk");
      assert.deepEqual(
        walk?.stop,
        { file: "", want: "" },
        `${mode}: the walk that opens takes no stop file`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  }
});

test("w6120: on, warn, on during the WRITE_OWNER grants: the first on gives back only, never fails, and the last switch sets on whole", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-w6120-"));
  try {
    const { appDir, inTurn, targets, sddlOf, givenBackFirst } = realPass(dir);
    const closed = targets.filter((t) => closes(t.sddl)).map((t) => t.path);
    const back = targets.filter((t) => !closes(t.sddl)).map((t) => t.path);
    writeReadFenceMode(appDir, "on");
    const later: Promise<void>[] = [];
    let step = 0;
    const said: string[] = [];
    const say = (l: string) => void said.push(l);
    // Every label is refused until its grant, as on LothDesktop's first on (2026-11-26).
    const w = fakeWindows({
      denied: new Set(targets.map((t) => t.path)),
      onCall: (c) => {
        if (step === 0 && c.kind === "grant") {
          step = 1;
          writeReadFenceMode(appDir, "warn");
          later.push(inTurn(w.exec, say));
        } else if (step === 1 && c.kind === "label") {
          step = 2;
          writeReadFenceMode(appDir, "on");
          later.push(inTurn(w.exec, say));
        }
      },
    });
    const first = inTurn(w.exec, say);
    await first; // resolves: a stop is no failure
    await Promise.all(later);
    const firstRetry = w.calls.findIndex(
      (c, i) => c.kind === "label" && i > 0 && w.calls[i - 1].kind === "grant",
    );
    const firstGrants = w.calls
      .slice(0, firstRetry)
      .filter((c) => c.kind === "grant")
      .flatMap((c) => c.paths);
    assert.deepEqual(
      firstGrants.sort(),
      [...back].sort(),
      "only the given-back paths were granted once the mode changed",
    );
    assert.deepEqual(
      w.calls[firstRetry].paths.sort(),
      [...back].sort(),
      "the retry set only the given-back paths",
    );
    assert.ok(
      said.some((l) =>
        l.includes("refused for want of WRITE_OWNER get no grant or retry"),
      ),
      said.join("\n"),
    );
    assert.ok(
      givenBackFirst(w.calls),
      "every label run put the given-back paths first",
    );
    // The end: on, every label set, and the last step is a walk inside that ran whole.
    assert.equal(readFenceMode(appDir), "on");
    for (const p of [...closed, ...back])
      assert.equal(w.labels.get(p), sddlOf.get(p), p);
    const last = w.calls[w.calls.length - 1];
    assert.equal(last.kind, "walk");
    assert.deepEqual(last.stop, {
      file: path.join(appDir, "read-fence"),
      want: "on",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("w6120: a mode that keeps changing under its passes stops after 5 rounds and says so", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-w6120-"));
  try {
    const { appDir, inTurn } = realPass(dir);
    writeReadFenceMode(appDir, "on");
    const ran: string[] = [];
    // Each label run flips the mode: on to warn, warn to on.
    const w = fakeWindows({
      onCall: (c) => {
        if (c.kind !== "label") return;
        const m = readFenceMode(appDir);
        ran.push(m);
        writeReadFenceMode(appDir, m === "on" ? "warn" : "on");
      },
    });
    const said: string[] = [];
    await inTurn(w.exec, (l) => void said.push(l));
    assert.deepEqual(ran, ["on", "warn", "on", "warn", "on"]);
    assert.ok(
      said.some((l) =>
        l.includes("changed again while its labels were set (now warn)"),
      ),
      said.join("\n"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("w6120: labelNoReadUp's access-denied path grants and retries with the given-backs first, and once stopped gives back only", async () => {
  const t = [
    { path: "D:\\ffw\\daemon", sddl: NO_READ_UP.dir },
    { path: "D:\\ffw\\daemon\\app", sddl: READ_BACK.dir },
    { path: "D:\\ffw\\root.json", sddl: NO_READ_UP.file },
    { path: "D:\\ffw\\daemon\\sandboxes.json", sddl: READ_BACK.file },
  ];
  const back = ["D:\\ffw\\daemon\\app", "D:\\ffw\\daemon\\sandboxes.json"];
  const all = [...back, "D:\\ffw\\daemon", "D:\\ffw\\root.json"];
  // Not stopped: both runs and the grants in order, given-backs first.
  const a = fakeWindows({ denied: new Set(t.map((x) => x.path)) });
  assert.equal(
    await labelNoReadUp(t, a.exec, () => {}, {
      systemDrive: () => false,
      account: "ffw\\owner",
      still: () => true,
    }),
    true,
  );
  assert.deepEqual(
    a.calls
      .filter((c) => c.kind !== "survey")
      .map((c) => `${c.kind} ${c.paths.join(",")}`),
    [
      `label ${all.join(",")}`,
      ...all.map((p) => `grant ${p}`),
      `label ${all.join(",")}`,
    ],
  );
  // The mode changes during the first grant: the closed paths get no grant and no retry; the given-backs still do.
  let wanted = true;
  const said: string[] = [];
  const b = fakeWindows({
    denied: new Set(t.map((x) => x.path)),
    onCall: (c) => void (c.kind === "grant" && (wanted = false)),
  });
  assert.equal(
    await labelNoReadUp(t, b.exec, (l) => void said.push(l), {
      systemDrive: () => false,
      account: "ffw\\owner",
      still: () => wanted,
    }),
    false,
  );
  assert.deepEqual(
    b.calls
      .filter((c) => c.kind !== "survey")
      .map((c) => `${c.kind} ${c.paths.join(",")}`),
    [
      `label ${all.join(",")}`,
      ...back.map((p) => `grant ${p}`),
      `label ${back.join(",")}`,
    ],
  );
  assert.deepEqual(
    [...b.labels.keys()].sort(),
    [...back].sort(),
    "nothing closed, the given-backs set",
  );
  assert.ok(
    said.some((l) =>
      l.includes(
        "2 closed path(s) refused for want of WRITE_OWNER get no grant or retry and stay without their label; setting the 2 given-back one(s) only",
      ),
    ),
    said.join("\n"),
  );
  // Changed before the label run: nothing runs.
  const c = fakeWindows();
  assert.equal(
    await labelNoReadUp(t, c.exec, () => {}, {
      systemDrive: () => false,
      still: () => false,
    }),
    false,
  );
  assert.ok(!c.calls.some((x) => x.kind === "label"));
});

test("w6120: the login watcher's tick waits for the label pass, queues once, and labels nothing once the mode is off", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-w6120-"));
  try {
    const { d, appDir, inTurn } = daemonIn(dir);
    const login = path.join(dir, ".credentials.json");
    fs.writeFileSync(login, "{}");
    Object.defineProperty(d, "loginFiles", {
      get: () => ({ closed: [login], left: [] }),
    });
    Object.defineProperty(d, "labelSystemDrive", { get: () => () => false });
    const tick = (
      d as unknown as { relabelLoginsInTurn: Pass }
    ).relabelLoginsInTurn.bind(d);
    for (const [mode, labelled] of [
      ["off", false],
      ["on", true],
    ] as const) {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      (d as unknown as { applyReadLabels: Apply }).applyReadLabels = async () =>
        held;
      writeReadFenceMode(appDir, "on");
      const w = fakeWindows();
      const pass = inTurn(w.exec, () => {});
      const t1 = tick(w.exec, () => {});
      const t2 = tick(w.exec, () => {});
      await new Promise((r) => setImmediate(r));
      assert.equal(w.calls.length, 0, "the tick waits for the pass");
      writeReadFenceMode(appDir, mode);
      release();
      await Promise.all([pass, t1, t2]);
      const runs = w.calls.filter((c) => c.kind === "label");
      assert.equal(
        runs.length,
        labelled ? 1 : 0,
        `${mode}: ${runs.length} label run(s)`,
      );
      if (labelled) assert.deepEqual(runs[0].paths, [login]);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
