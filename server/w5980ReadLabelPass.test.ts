import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Daemon, type Probes } from "../machine/daemon.ts";
import {
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
