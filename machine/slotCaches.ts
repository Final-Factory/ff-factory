/**
 * Per-slot tool caches and the shared-cache lock (w5615, stage 2 of w5544; docs/worker-root.md "Per-slot caches and the
 * players broker").
 *
 * Every sandbox worker used to write one set of tool caches (`<root>/cache/<tool>`, sharedCaches.ts workerToolCacheEnv), so
 * one worker could plant a wheel, an npm tarball or a NuGet package every other worker then ran. Now each sandbox gets its
 * own copy-on-write clone, `<root>/cache/slots/<sandbox>/<tool>`, made from the shared seed `<root>/cache/<tool>`:
 * - made when the daemon sees a sandbox without one (a new sandbox, or the first run after this ships), in the background;
 * - a block clone where the disk has one (APFS clonefile, a reflink on Btrfs or XFS, the Windows copy engine on a ReFS Dev
 *   Drive), a full copy elsewhere (server/proc.ts copyTree);
 * - refreshed once a day while the sandbox is idle: what is new in the clone goes back into the seed first (mergeBack), then
 *   the clone is made again from the seed, so every slot gets what any slot downloaded;
 * - each sandbox agent's and editor's environment names its own clone (UV_CACHE_DIR, PIP_CACHE_DIR and the rest).
 * Measured on m5, 2026-11-26: an APFS clone of cache/uv (331 MB) took 1.62 s; `uv run --with pillow` ran in 0.042-0.044 s warm
 * from the clone as from the shared cache (first run 0.067 s against 0.145 s).
 *
 * Merge-back copies only entries the tool names by their content (a wheel's archive folder, a cacache blob, a NuGet
 * package version, a Playwright browser revision), never an environment or an index a tool rewrites in place, and only
 * entries nobody touched for a minute, each copied beside its place and renamed in, so a half-written one never lands.
 * The daemon does every write to the seed; a worker's own writes stay in its clone.
 *
 * daemon.json `sharedLock` (set by `ops_worker machine_update shared_lock`):
 * - unset or "off": nothing changes; workers share the seeds as before;
 * - "warn": clones are made and named in the environment, the players broker is on (machine/playersBroker.ts), and the
 *   daemon logs each write it did not make to the seeds, players, seed and tools: the writes "on" would refuse;
 * - "on": as "warn", and the fences make those folders read-only to workers (Windows: a Medium label, never an ACE;
 *   macOS and Linux: outside the write set), when every sandbox has its clones. Otherwise it holds off, says why, and warns.
 * Way back: `shared_lock off` and the daemon's restart the update makes; the next workers get the shared seeds again.
 */
import fs from "node:fs";
import path from "node:path";
import { sharedCacheDir } from "./sharedCaches.ts";
import { plainDirAt, writeFileSafe, type WorkerCopy } from "./workerCopy.ts";

export type SharedLockSetting = "off" | "warn" | "on";

/** The setting as daemon.json has it; anything unknown is "off". */
export function sharedLockSetting(v: unknown): SharedLockSetting {
  return v === "warn" || v === "on" ? v : "off";
}

/** Where the per-slot clones live, under the shared cache folder. */
export const SLOTS_CHILD = "slots";
export const slotCachesRoot = (root: string) =>
  path.join(sharedCacheDir(root), SLOTS_CHILD);
const SANDBOX_ID = /^[A-Za-z0-9][\w.-]{0,63}$/;
/** A sandbox id the per-slot folders accept: one path segment, nothing that climbs. */
export const okSandboxId = (id: string | undefined): id is string =>
  !!id &&
  SANDBOX_ID.test(id) &&
  id !== "." &&
  id !== ".." &&
  !id.includes("..");
export const slotCacheDir = (root: string, sandbox: string) =>
  path.join(slotCachesRoot(root), sandbox);
/** The clone's done marker: the clone is used only once it is there (a half-made one never is). */
export const MARKER = ".ff-slot-cache.json";

/**
 * How merge-back finds a tool's content-addressed entries, relative to the tool's folder:
 * - `dirs`: [top-level folder pattern, depth]: each folder that deep under a matching top folder is one entry, copied whole
 *   when the seed has none by that name; `done` names a file the entry must hold to count as complete;
 * - `files`: top-level folder patterns under which every file is an entry ('' for the tool folder itself).
 */
interface MergeRule {
  dirs?: { top: RegExp; depth: number; done?: string }[];
  files?: RegExp[];
}

export interface SlotCacheTool {
  /** The folder under cache/ (and under cache/slots/<sandbox>/). */
  dir: string;
  /** The environment variable that names it. */
  env: string;
  /** How new entries go back to the seed; none: the clone is the slot's own (a tool home, not a cache). */
  merge?: MergeRule;
  /** Not on this OS. */
  platforms?: NodeJS.Platform[];
}

/**
 * The cloned caches, each with the variable its tool reads (sharedCaches.ts workerToolCacheEnv for the sources). uv:
 * archive-v0 holds each unpacked wheel under its content hash, and wheels-v* the pointers to them; environments-v*,
 * builds-v* and the index cache (simple-v*) are rewritten in place or name the slot's own paths, so they stay in the clone.
 * pip: its http cache and built wheels are named by a hash. npm: _cacache is content-addressed (content-v2, index-v5).
 * NuGet: `<id>/<version>` with `.nupkg.metadata`, which NuGet writes last. Playwright: one folder per browser revision with
 * INSTALLATION_COMPLETE. UPM's cache is a registry mirror, named by package and version. .NET's CLI home holds a
 * first-run sentinel and tool shims: the slot's own.
 */
export const SLOT_CACHE_TOOLS: readonly SlotCacheTool[] = [
  {
    dir: "uv",
    env: "UV_CACHE_DIR",
    merge: {
      dirs: [{ top: /^archive-v\d+$/, depth: 1 }],
      files: [/^wheels-v\d+$/],
    },
  },
  {
    dir: "pip",
    env: "PIP_CACHE_DIR",
    merge: { files: [/^http(-v\d+)?$/, /^wheels$/] },
  },
  { dir: "npm", env: "npm_config_cache", merge: { files: [/^_cacache$/] } },
  {
    dir: path.join("nuget", "packages"),
    env: "NUGET_PACKAGES",
    merge: { dirs: [{ top: /^[^.]/, depth: 1, done: ".nupkg.metadata" }] },
  },
  { dir: "upm", env: "UPM_CACHE_ROOT", merge: { files: [/^(?!.*\.lock$)./] } },
  { dir: "dotnet", env: "DOTNET_CLI_HOME" },
  {
    dir: "ms-playwright",
    env: "PLAYWRIGHT_BROWSERS_PATH",
    merge: {
      dirs: [{ top: /^[^.]/, depth: 0, done: "INSTALLATION_COMPLETE" }],
    },
  },
];

/** The determinism audit's own folder per slot (FF_DETERMINISM_AUDIT_DIR): made empty, never cloned or merged. */
export const slotAuditDir = (root: string, sandbox: string) =>
  path.join(slotCacheDir(root, sandbox), "determinism-audit");

export interface SlotMarker {
  v: 1;
  /** When the clone was made from the seed (ms). */
  made: number;
  /** Tools cloned, by folder. */
  tools: string[];
}

export function readMarker(dir: string): SlotMarker | undefined {
  try {
    const m = JSON.parse(
      fs.readFileSync(path.join(dir, MARKER), "utf8"),
    ) as SlotMarker;
    return m && m.v === 1 && Number.isFinite(m.made) && Array.isArray(m.tools)
      ? m
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A sandbox's environment for its own clones (every sandbox agent and editor, with sharedLock "warn" or "on"). A tool whose
 * clone is not made yet keeps the shared seed under "warn"; under "on" it gets its slot's folder all the same (empty until
 * the clone is made: a download, never a refused write). The determinism audit folder is the slot's own either way.
 */
export function slotCacheEnv(
  root: string | undefined,
  sandbox: string | undefined,
  setting: SharedLockSetting,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = fs.existsSync,
): Record<string, string> {
  if (!root || setting === "off" || !okSandboxId(sandbox)) return {};
  const dir = slotCacheDir(root, sandbox);
  const made = readMarker(dir);
  const out: Record<string, string> = {
    FF_DETERMINISM_AUDIT_DIR: slotAuditDir(root, sandbox),
  };
  for (const t of SLOT_CACHE_TOOLS) {
    if (t.platforms && !t.platforms.includes(platform)) continue;
    const own = path.join(dir, t.dir);
    if (setting === "on" || (made?.tools.includes(t.dir) && exists(own)))
      out[t.env] = own;
  }
  return out;
}

export interface SlotCachesDeps {
  root: string;
  setting: SharedLockSetting;
  /** Every sandbox the pool knows, and whether nothing runs in it now (no agent, no editor, no build). */
  sandboxes: () =>
    | { id: string; idle: boolean }[]
    | Promise<{ id: string; idle: boolean }[]>;
  /**
   * The copy with a worker's rights (machine/workerCopy.ts workerCopier; a block clone where the disk has one): the seed
   * and the clones are folders workers can change under "warn", so the daemon never reads them with its own (w6212 B1).
   */
  copy: WorkerCopy;
  removeTree: (dir: string) => Promise<void>;
  log: (l: string) => void;
  now?: () => number;
  /** How old a clone gets before an idle sandbox's is made again (default a day). */
  refreshMs?: number;
}

export const REFRESH_MS = 24 * 3600_000;
/** An entry touched this recently may still be being written: merge-back leaves it for the next pass. */
export const QUIET_MS = 60_000;

/** Every entry of `tool` in `src` (a clone) that `rule` names, as paths relative to the tool folder, with their kind. */
export function mergeEntries(
  src: string,
  rule: MergeRule,
  now: number,
  quietMs = QUIET_MS,
): { rel: string; dir: boolean }[] {
  const out: { rel: string; dir: boolean }[] = [];
  const list = (d: string): fs.Dirent[] => {
    try {
      return fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const quiet = (p: string) => {
    try {
      return now - fs.lstatSync(p).mtimeMs >= quietMs;
    } catch {
      return false;
    }
  };
  for (const top of list(src)) {
    if (top.name === MARKER || top.name.startsWith(".ff-merge-")) continue;
    for (const r of rule.dirs ?? []) {
      if (!r.top.test(top.name) || !top.isDirectory()) continue;
      let level: string[] = [top.name];
      for (let i = 0; i < r.depth; i++)
        level = level.flatMap((rel) =>
          list(path.join(src, rel))
            .filter((e) => e.isDirectory() && !e.name.startsWith(".ff-merge-"))
            .map((e) => path.join(rel, e.name)),
        );
      for (const rel of level) {
        const abs = path.join(src, rel);
        if (r.done && !fs.existsSync(path.join(abs, r.done))) continue;
        if (quiet(abs)) out.push({ rel, dir: true });
      }
    }
    const fileRule = (rule.files ?? []).find((re) => re.test(top.name));
    if (!fileRule) continue;
    if (top.isFile()) {
      if (quiet(path.join(src, top.name)))
        out.push({ rel: top.name, dir: false });
      continue;
    }
    if (!top.isDirectory()) continue;
    const walk = (rel: string) => {
      for (const e of list(path.join(src, rel))) {
        const r2 = path.join(rel, e.name);
        if (e.isDirectory()) walk(r2);
        else if (
          e.isFile() &&
          !e.name.endsWith(".tmp") &&
          quiet(path.join(src, r2))
        )
          out.push({ rel: r2, dir: false });
      }
    };
    walk(top.name);
  }
  return out;
}

/**
 * Copy into the seed each entry of the clone the seed lacks (by relative path). The copy is made with a worker's rights
 * into `stage` (a `.ff-merge-` folder in the slot's own cache folder, on the seed's disk), then moved into the seed, so a
 * reader of the seed sees a whole entry or none and a link in the clone reaches only what a worker reads (w6212 B1).
 * Never replaces or deletes what the seed has: a folder entry is renamed in (refused where the seed has one with content),
 * a file entry hard-linked in, which fails where the seed got that file meanwhile (L3: a rename would replace it). The
 * seed's folders on the way must be plain folders (no link a worker planted under "warn"). The entry's own mtime decides
 * "quiet" (mergeEntries): that holds because uv renames an entry in whole and the NuGet and Playwright rules wait for
 * their done-files; a tool that writes into an entry in place needs a done-file rule too. Returns how many went back.
 */
/**
 * Each folder from `seed` down to `seed/rel` is a plain folder where it should be; a missing one is made, one level at a
 * time, only below a folder already checked (w6212 B2: a recursive mkdir would follow a link a worker planted).
 */
function plainDirsTo(seed: string, rel: string): boolean {
  let at = "";
  for (const part of rel === "." ? [] : rel.split(path.sep)) {
    at = at ? path.join(at, part) : part;
    const dir = path.join(seed, at);
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(dir);
    } catch {
      st = undefined;
    }
    if (!st) fs.mkdirSync(dir);
    if (!plainDirAt(dir, seed, at)) return false;
  }
  return true;
}

export async function mergeBack(
  clone: string,
  seed: string,
  rule: MergeRule,
  copy: WorkerCopy,
  now = Date.now(),
  quietMs = QUIET_MS,
  stage = path.join(path.dirname(clone), ".ff-merge"),
): Promise<number> {
  let n = 0;
  for (const e of mergeEntries(clone, rule, now, quietMs)) {
    const dst = path.join(seed, e.rel);
    if (fs.existsSync(dst)) continue;
    const tmp = path.join(stage, `${process.pid}-${now}-${n}-${path.basename(dst)}`);
    try {
      fs.mkdirSync(stage, { recursive: true });
      if (!plainDirsTo(seed, path.dirname(e.rel))) continue;
      await copy(path.join(clone, e.rel), tmp, { links: "keep" });
      if (e.dir) fs.renameSync(tmp, dst);
      else {
        // a file a worker swapped for a link, or a hard link to a file elsewhere, while the copy ran goes no further
        const st = fs.lstatSync(tmp);
        if (!st.isFile() || st.nlink !== 1) continue;
        fs.linkSync(tmp, dst);
        fs.rmSync(tmp, { force: true });
      }
      n++;
    } catch {
      // the next pass tries again
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return n;
}

/**
 * Makes and refreshes the clones (the daemon's 10-minute timer calls tick). One sandbox per tick at most, so a slow full
 * copy on a disk without clones never holds the daemon's other work.
 */
export class SlotCaches {
  private busy = false;
  private d: SlotCachesDeps;
  constructor(d: SlotCachesDeps) {
    this.d = d;
  }

  private now() {
    return (this.d.now ?? Date.now)();
  }

  /** The tools whose seed folder is there to clone (a tool nobody used yet has none: its slot folder starts empty). */
  private seeds(): SlotCacheTool[] {
    return SLOT_CACHE_TOOLS.filter(
      (t) => !t.platforms || t.platforms.includes(process.platform),
    );
  }

  async tick(): Promise<string | undefined> {
    if (this.d.setting === "off" || this.busy) return undefined;
    this.busy = true;
    try {
      const all = (await this.d.sandboxes()).filter((s) => okSandboxId(s.id));
      // First the sandboxes with no clone, idle or not (a clone of a seed nobody else writes is safe while a worker runs:
      // its own folder is made beside, renamed in, and named in the environment only from its next run on).
      const none = all.find(
        (s) => !readMarker(slotCacheDir(this.d.root, s.id)),
      );
      if (none) return await this.make(none.id, false);
      const old = all.find(
        (s) =>
          s.idle &&
          this.now() -
            (readMarker(slotCacheDir(this.d.root, s.id))?.made ?? 0) >
            (this.d.refreshMs ?? REFRESH_MS),
      );
      if (old) return await this.make(old.id, true);
      return undefined;
    } catch (e) {
      const l = `slot caches: ${(e as Error).message}`;
      this.d.log(l);
      return l;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Make a sandbox's clones (again). `refresh`: the sandbox is idle and had clones: merge what is new back into the seed
   * first, then replace each clone. A tool whose seed is missing gets an empty folder.
   */
  async make(sandbox: string, refresh: boolean): Promise<string> {
    const dir = slotCacheDir(this.d.root, sandbox);
    fs.mkdirSync(dir, { recursive: true });
    // w6212 B2: cache/slots is worker-writable; the daemon writes and deletes only in a plain folder where it should be.
    if (!plainDirAt(dir, this.d.root, path.relative(this.d.root, dir)))
      throw new Error(`${dir} is a link or junction, or lies below one; its clones are left alone (w6212)`);
    fs.mkdirSync(slotAuditDir(this.d.root, sandbox), { recursive: true });
    const seedRoot = sharedCacheDir(this.d.root);
    const t0 = this.now();
    let merged = 0;
    const tools: string[] = [];
    const failed: string[] = [];
    for (const t of this.seeds()) {
      const own = path.join(dir, t.dir);
      const seed = path.join(seedRoot, t.dir);
      if (refresh && t.merge && fs.existsSync(own)) {
        fs.mkdirSync(seed, { recursive: true });
        if (plainDirAt(seed, seedRoot, t.dir))
          merged += await mergeBack(
            own,
            seed,
            t.merge,
            this.d.copy,
            this.now(),
            QUIET_MS,
            path.join(dir, ".ff-merge"),
          );
      }
      // Not refreshed: a clone already there stays (the slot may use it). Refreshed or new: made beside, renamed in.
      if (!refresh && fs.existsSync(own)) {
        tools.push(t.dir);
        continue;
      }
      const fresh = path.join(
        path.dirname(own),
        `.ff-new-${path.basename(own)}`,
      );
      const gone = path.join(
        path.dirname(own),
        `.ff-old-${path.basename(own)}`,
      );
      try {
        for (const p of [fresh, gone])
          if (fs.existsSync(p)) await this.d.removeTree(p);
        fs.mkdirSync(path.dirname(own), { recursive: true });
        if (fs.existsSync(seed)) await this.d.copy(seed, fresh, { links: "keep" });
        else fs.mkdirSync(fresh, { recursive: true });
        if (fs.existsSync(own)) fs.renameSync(own, gone);
        fs.renameSync(fresh, own);
        if (fs.existsSync(gone)) await this.d.removeTree(gone);
        tools.push(t.dir);
      } catch (e) {
        failed.push(
          `${t.dir} (${(e as Error).message.split("\n")[0].slice(0, 200)})`,
        );
        if (fs.existsSync(fresh))
          await this.d.removeTree(fresh).catch(() => undefined);
        if (!fs.existsSync(own) && fs.existsSync(gone))
          fs.renameSync(gone, own);
        if (fs.existsSync(own)) tools.push(t.dir);
      }
    }
    const marker: SlotMarker = { v: 1, made: this.now(), tools };
    writeFileSafe(path.join(dir, MARKER), JSON.stringify(marker));
    const secs = ((this.now() - t0) / 1000).toFixed(1);
    const line = `slot caches: ${sandbox}: ${refresh ? "made again" : "made"} from the shared seed in ${secs} s (${tools.join(", ")})${refresh ? `, ${merged} new entr${merged === 1 ? "y" : "ies"} merged back first` : ""}${failed.length ? `; failed: ${failed.join("; ")}` : ""} (w5615)`;
    this.d.log(line);
    return line;
  }
}

/**
 * The folders "warn" watches for writes the daemon did not make, and "on" makes read-only to workers: the seeds of the cloned
 * caches, players (the broker installs and launches; machine/playersBroker.ts), the Library seed and tools. cache/slots,
 * cache/uv-tools, cache/uv-bin, cache/xdg and cache/cargo stay worker-writable (docs/worker-root.md: cargo is the next stage).
 */
export function sharedLockedFolders(root: string): string[] {
  const c = sharedCacheDir(root);
  return [
    ...SLOT_CACHE_TOOLS.map((t) => path.join(c, t.dir)),
    path.join(root, "players"),
    path.join(root, "seed"),
    path.join(root, "tools"),
  ];
}

/** The log line for the setting at daemon start. */
export function sharedLockLine(
  setting: SharedLockSetting,
  blockers: string[] = [],
): string | undefined {
  if (setting === "off") return undefined;
  if (setting === "warn")
    return `shared lock: warn only (w5615); each sandbox gets its own clones of the tool caches and players go through the daemon, nothing is refused, and worker writes to the shared caches, players, seed and tools are logged${blockers.length ? `. With "on" it would stay off: ${blockers.join("; ")}` : ""}`;
  return blockers.length
    ? `shared lock: on asked, but held off (writes the daemon did not make are logged instead): ${blockers.join("; ")}`
    : 'shared lock: "on" asked, but this release enforces nothing yet and runs as warn (w6212 M2; the enforcing change is its own pull request): worker writes to the shared caches, players, seed and tools are logged, never refused';
}

/**
 * What keeps "on" from applying: a sandbox with no clones yet (its agents would download everything again), or no root.
 */
export function sharedLockBlockers(
  root: string | undefined,
  sandboxes: string[],
): string[] {
  if (!root) return ["this install has no worker root"];
  const none = sandboxes.filter(
    (s) => okSandboxId(s) && !readMarker(slotCacheDir(root, s)),
  );
  return none.length
    ? [
        `sandbox${none.length === 1 ? "" : "es"} ${none.join(", ")} without their own cache clones yet (made within minutes of the daemon's start)`,
      ]
    : [];
}

/**
 * Watch the locked folders ("warn", or "on" held off) and log each write the daemon did not make, at most one line per
 * folder and top entry per hour. Not recursive (w5764's lesson: an inotify watch per folder): each folder and its first level.
 * `daemonBusy` says a write now is the daemon's own (a merge-back, an install).
 */
export function watchShared(
  folders: string[],
  log: (l: string) => void,
  o: { daemonBusy?: () => boolean; now?: () => number } = {},
): () => void {
  const now = o.now ?? Date.now;
  const said = new Map<string, number>();
  const ws: fs.FSWatcher[] = [];
  const watchOne = (dir: string, top: string) => {
    try {
      const w = fs.watch(dir, { persistent: false }, (_ev, name) => {
        if (o.daemonBusy?.()) return;
        const n = typeof name === "string" ? name : "";
        if (
          n === SLOTS_CHILD ||
          n.startsWith(".ff-") ||
          n.endsWith(".tmp") ||
          n.endsWith(".lock") ||
          n === "pool.lock"
        )
          return;
        const key = `${top}/${n}`;
        const t = now();
        if ((said.get(key) ?? -Infinity) > t - 3600_000) return;
        said.set(key, t);
        log(
          `shared lock (warn): ${path.join(dir, n)} changed and the daemon did not write it; a worker's write there is refused once shared_lock is on (w5615)`,
        );
      });
      w.on("error", () => undefined);
      ws.push(w);
    } catch {
      // not there
    }
  };
  for (const f of folders) {
    if (!fs.existsSync(f)) continue;
    watchOne(f, f);
    try {
      for (const e of fs.readdirSync(f, { withFileTypes: true }))
        if (
          e.isDirectory() &&
          e.name !== SLOTS_CHILD &&
          !e.name.startsWith(".ff-")
        )
          watchOne(path.join(f, e.name), f);
    } catch {
      // gone
    }
  }
  return () => {
    for (const w of ws) w.close();
  };
}
