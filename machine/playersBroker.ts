/**
 * The players broker (w5615, stage 2 of w5544; docs/worker-root.md "Per-slot caches and the players broker"). Built players
 * run only from `<root>/players/<sandbox>-<peer>` (docs/worker-root.md 2.5: a stable path, so no firewall prompt). Workers
 * used to fill those folders themselves (the game repo's scripts/nightly/player_slots.py), so any worker could replace the
 * build another sandbox's run was about to start. With daemon.json `sharedLock` "warn" or "on" a worker asks the daemon
 * instead (machine/daemonRpc.ts, from scripts/bench/daemon_rpc.py with FF_PLAYER_BROKER=1):
 * - `players/install` {player, sha?, peer?}: the daemon copies the build into the caller's own slot, a block clone where the
 *   disk has one and never a hard link (a hard link would share the file, and on Windows its label, with the worker's
 *   build), and writes slot.json as player_slots.py does. A slot already holding the same build is kept.
 * - `players/launch` {peer?, args, config?}: the daemon starts the slot's player, fenced as its timed runs are
 *   (machine/playerFence.ts; on Windows through the Low node copy, so the player runs Low and the worker can end it), with
 *   no credential in its environment, and writes the lease with the caller's session. Answers the pid.
 * - `players/release` {lease}: the caller's own lease goes. `players/status`: the caller's slots.
 * The slot comes from the caller's token (its sandbox), never from the body: a worker reaches only its own two slots.
 * The build must lie in the caller's sandbox, its own temp folder, the nightly folder or a ready entry of this machine's
 * player cache (w6286: `<cache>/<sha>-<os>/player/...` whose build-manifest.json says ok), never in players, the daemon's
 * folder or the secrets, and it is copied with the worker's rights (machine/workerCopy.ts), never the daemon's. Before it
 * writes or deletes in a slot (a folder workers can change under "warn") the broker checks the slot, its player/ and
 * leases/ are plain folders where they should be, and writes no file through a link (w6212 B1, B2).
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RpcRefused, type Caller } from "./daemonRpc.ts";
import { PLAYER_CACHE_ENTRY } from "./playerCache.ts";
import { okSandboxId } from "./slotCaches.ts";
import { isLinkAt, linkIn, plainDirAt, real, writeFileSafe, writeNew, type WorkerCopy } from "./workerCopy.ts";

/** What a running player writes into its own folder (the game's LocalMultiplayerAutomationSessionConfig): not the build. */
export const RUNTIME_FILES = new Set([
  ".ff-local-automation-status.json",
  ".ff-local-automation.json",
]);
export const AUTOMATION_CONFIG = ".ff-local-automation.json";
/** RpcRefused takes the message first; here the status reads first. */
const refuse = (status: number, message: string) =>
  new RpcRefused(message, status);
const MAX_ARGS = 200;
const MAX_ARG = 4096;
/** Under the daemon RPC's 16 KB body (machine/daemonRpc.ts MAX_BODY). */
const MAX_CONFIG = 12 * 1024;

export interface PlayersMarker {
  sha: string;
  fingerprint: string;
  state: "filling" | "ready";
  source: string;
  /** Where the build lands under player/ ('' for an exe's folder, the .app's name for a bundle) and what to start there. */
  lands: string;
  entry: string;
  filled: number;
  used: number;
  /** Written by the daemon's broker (player_slots.py fills a slot of its own otherwise). */
  broker: true;
}

export interface BrokerLaunch {
  exe: string;
  args: string[];
  cwd: string;
  /** The slot folder: the player may write there (its status file), and its run folder. */
  slotDir: string;
  sandbox: string;
  session: string;
  /** The folder of its -logFile, when that lies in the caller's own temp folder: the player writes its log there. */
  logDir?: string;
}

export interface PlayersBrokerDeps {
  root: string;
  host: string;
  /** The caller's sandbox folder, from the pool. */
  sandboxPath: (id: string) => string | undefined;
  /** The copy with the worker's rights (machine/workerCopy.ts workerCopier). */
  copy: WorkerCopy;
  removeTree: (dir: string) => Promise<void>;
  /** Where the workers' temp folders are (`ffa-<session>` each; default `<root>/tmp`). */
  tempDir?: string;
  /**
   * w6286: this machine's player cache (machine/playerCache.ts playerCacheRoot), where build_player.sh keeps past builds and
   * most launches take theirs from. Workers write it, as they write nightly, so it opens no more than they could copy: the
   * copy runs with the worker's rights and refuses links (machine/workerCopy.ts), into the caller's own slot only.
   */
  playerCache?: string;
  /** Start the player, fenced, detached; answers its pid or why it was not started. */
  launch: (l: BrokerLaunch) => Promise<{ pid: number } | { refused: string }>;
  alive?: (pid: number) => boolean;
  log: (l: string) => void;
  now?: () => number;
  /** "warn": note it in the log; the broker answers the same either way. */
  platform?: NodeJS.Platform;
}

const inside = (p: string, dir: string) => {
  const r = path.relative(dir, p);
  return r === "" || (!!r && !r.startsWith("..") && !path.isAbsolute(r));
};
const alive0 = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The folder to mirror, where it lands under player/, and the entry to start (player_slots.py split_player). */
export function splitPlayer(player: string): {
  src: string;
  lands: string;
  entry: string;
} {
  const p = path.resolve(player.replace(/[\\/]+$/, ""));
  if (p.endsWith(".app"))
    return { src: p, lands: path.basename(p), entry: path.basename(p) };
  if (/\.(exe|x86_64)$/i.test(p))
    return { src: path.dirname(p), lands: "", entry: path.basename(p) };
  throw refuse(
    400,
    `players/install: player is a built player's .exe, .x86_64 or .app, not ${path.basename(p)}`,
  );
}

/**
 * Which build a folder holds: every file's relative path, size and modification time (never its content: 2-3 GB), the
 * runtime files left out. Not player_slots.py's fingerprint: a slot the broker filled is reused only by the broker.
 */
export function buildKey(tree: string): string {
  const h = createHash("sha256");
  const files: string[] = [];
  const walk = (rel: string) => {
    let es: fs.Dirent[] = [];
    try {
      es = fs.readdirSync(path.join(tree, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (RUNTIME_FILES.has(e.name)) continue;
      if (e.isDirectory()) walk(r);
      else files.push(r);
    }
  };
  if (fs.statSync(tree).isDirectory()) walk("");
  for (const r of files.sort()) {
    const st = fs.lstatSync(path.join(tree, r));
    h.update(
      `${r.replace(/\\/g, "/")}\0${st.size}\0${Math.trunc(st.mtimeMs)}\0`,
    );
  }
  return `broker-v1-${h.digest("hex").slice(0, 32)}`;
}

/** The Mac bundle's executable (Contents/MacOS/<CFBundleExecutable>, the only file there in a Unity build). */
export function bundleExe(app: string): string {
  const dir = path.join(app, "Contents", "MacOS");
  const files = fs.readdirSync(dir).filter((n) => !n.startsWith("."));
  if (files.length !== 1)
    throw refuse(
      409,
      `players/launch: ${dir} holds ${files.length} files, not one executable`,
    );
  return path.join(dir, files[0]);
}

export function playersRpcHandlers(
  d: PlayersBrokerDeps,
): Record<string, (c: Caller, b: Record<string, unknown>) => unknown> {
  const now = () => (d.now ?? Date.now)();
  const alive = d.alive ?? alive0;
  const players = path.join(d.root, "players");
  let chain: Promise<unknown> = Promise.resolve();
  /** One install or launch at a time: they share the slot folders and the daemon has one view of them. */
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const p = chain.then(f, f);
    chain = p.catch(() => undefined);
    return p;
  };
  const slotOf = (c: Caller, b: Record<string, unknown>) => {
    if (!okSandboxId(c.sandbox))
      throw refuse(403, "players: only a sandbox worker has player slots");
    const peer = b.peer === undefined ? 0 : b.peer;
    if (peer !== 0 && peer !== 1) throw refuse(400, "players: peer is 0 or 1");
    const name = `${c.sandbox}-${peer}`;
    return { name, dir: path.join(players, name), sandbox: c.sandbox };
  };
  const readMarker = (dir: string): PlayersMarker | undefined => {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(dir, "slot.json"), "utf8"),
      ) as PlayersMarker;
    } catch {
      return undefined;
    }
  };
  const writeJson = (file: string, data: unknown) =>
    writeFileSafe(file, JSON.stringify(data, null, 1));
  /**
   * B2: the slot is a plain folder at players/<name> (players itself one at <root>/players), with nothing in it a link,
   * and its player/ and leases/ plain folders where they are. Made when `make` and missing. Refuses otherwise.
   */
  const isLink = isLinkAt; // lstat or the parent's Dirent: a \??\Global\ junction too (w6247)
  const plainSlot = (slot: { name: string; dir: string }, make: boolean) => {
    const bad = (why: string) =>
      refuse(409, `players: ${slot.name} ${why}; the broker writes nothing through a link or junction (w6212)`);
    const there = (p: string) => fs.existsSync(p) || isLink(p);
    if (!make && !there(players)) return; // nothing installed yet: nothing to write through
    if (make && !there(players)) fs.mkdirSync(players, { recursive: true });
    if (!plainDirAt(players, d.root, "players")) throw bad("lies under a players folder that is a link");
    // each folder is checked before the broker makes anything in it, never after
    if (make && !there(slot.dir)) fs.mkdirSync(slot.dir);
    if (!there(slot.dir)) return;
    if (!plainDirAt(slot.dir, players, slot.name)) throw bad("is a link or junction, not a folder");
    for (const e of fs.readdirSync(slot.dir, { withFileTypes: true }))
      if (e.isSymbolicLink()) throw bad(`holds a link (${e.name})`);
    for (const sub of ["leases", "player"]) {
      const p = path.join(slot.dir, sub);
      if (fs.existsSync(p) && !plainDirAt(p, slot.dir, sub)) throw bad(`has ${sub}/ as a link`);
    }
    if (make && !there(path.join(slot.dir, "leases"))) fs.mkdirSync(path.join(slot.dir, "leases"));
  };
  /** The slot's live leases (player_slots.py live_leases: a lease whose pid is gone is dead). Reads only. */
  const liveLeases = (dir: string) => {
    const ld = path.join(dir, "leases");
    let names: string[] = [];
    try {
      names = fs.readdirSync(ld).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: {
      file: string;
      pid: number;
      session?: string;
      host?: string;
    }[] = [];
    for (const n of names) {
      try {
        const l = JSON.parse(fs.readFileSync(path.join(ld, n), "utf8")) as {
          pid?: number;
          session?: string;
          host?: string;
        };
        const local = !l.host || l.host === d.host;
        if (Number.isInteger(l.pid) && (!local || alive(l.pid!)))
          out.push({
            file: n,
            pid: l.pid!,
            ...(l.session ? { session: l.session } : {}),
            ...(l.host ? { host: l.host } : {}),
          });
      } catch {
        // half-written or gone
      }
    }
    return out;
  };
  const ownTemp = (c: Caller) =>
    path.join(d.tempDir ?? path.join(d.root, "tmp"), `ffa-${c.session.replace(/[^\w-]/g, "").slice(0, 40)}`);
  const allowedSource = (c: Caller, src: string): boolean => {
    const s = real(src);
    const closed = [
      players,
      path.join(d.root, "daemon"),
      path.join(d.root, "secrets"),
    ].map(real);
    if (closed.some((x) => inside(s, x))) return false;
    const sb = c.sandbox ? d.sandboxPath(c.sandbox) : undefined;
    // M1: the caller's own temp folder, not every session's.
    const open = [sb, c.session ? ownTemp(c) : undefined, path.join(d.root, "nightly")]
      .filter((x): x is string => !!x)
      .map(real);
    return open.some((x) => inside(s, x)) || cacheEntryPlayer(s);
  };
  /** w6286: `s` is inside the player/ folder of a ready player-cache entry (as playerCache.ts readPlayerCache reports them). */
  const cacheEntryPlayer = (s: string): boolean => {
    if (!d.playerCache || !fs.existsSync(d.playerCache)) return false;
    const cache = real(d.playerCache);
    if (!inside(s, cache)) return false;
    const [key, sub] = path.relative(cache, s).split(/[\\/]/);
    if (!key || !PLAYER_CACHE_ENTRY.test(key) || sub !== "player") return false;
    // w6293 review: the daemon reads the manifest with its own rights, so only a plain file, never through a link (a link
    // would tell a worker whether a file only the daemon reads is JSON with status ok). The open file must still be the
    // one lstat saw, so a link swapped in between is refused too.
    const file = path.join(cache, key, "build-manifest.json");
    let fd: number | undefined;
    try {
      const before = fs.lstatSync(file, { bigint: true });
      if (!before.isFile() || isLinkAt(file)) return false;
      fd = fs.openSync(file, "r");
      const open = fs.fstatSync(fd, { bigint: true });
      if (open.ino !== before.ino || open.dev !== before.dev) return false;
      const m = JSON.parse(fs.readFileSync(fd, "utf8")) as { status?: unknown };
      return m.status === "ok";
    } catch {
      return false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };

  return {
    "players/status": (c) => {
      if (!okSandboxId(c.sandbox))
        throw refuse(403, "players: only a sandbox worker has player slots");
      return {
        slots: [0, 1].map((peer) => {
          const dir = path.join(players, `${c.sandbox}-${peer}`);
          return {
            slot: path.basename(dir),
            dir,
            marker: readMarker(dir) ?? null,
            leases: liveLeases(dir),
          };
        }),
      };
    },

    "players/install": (c, b) =>
      serial(async () => {
        const slot = slotOf(c, b);
        if (typeof b.player !== "string" || !path.isAbsolute(b.player))
          throw refuse(
            400,
            "players/install: player is the absolute path of a built player",
          );
        const sha = typeof b.sha === "string" ? b.sha.slice(0, 64) : "";
        const { src, lands, entry } = splitPlayer(b.player);
        if (
          !fs.existsSync(src) ||
          !fs.existsSync(path.join(src, lands ? "" : entry))
        )
          throw refuse(404, `players/install: no player at ${b.player}`);
        if (!allowedSource(c, src))
          throw refuse(
            403,
            `players/install: ${src} is not in your sandbox, your own temp folder, the nightly folder or a ready player-cache entry's player folder`,
          );
        const fingerprint = buildKey(src);
        plainSlot(slot, true);
        const m = readMarker(slot.dir);
        const dst = path.join(slot.dir, "player");
        if (
          m?.broker &&
          m.state === "ready" &&
          m.sha === sha &&
          m.fingerprint === fingerprint &&
          m.entry === entry &&
          fs.existsSync(path.join(dst, lands ? entry : entry))
        ) {
          m.used = now();
          writeJson(path.join(slot.dir, "slot.json"), m);
          return {
            slot: slot.name,
            slotDir: slot.dir,
            player: path.join(dst, entry),
            filled: false,
            build: fingerprint,
          };
        }
        const live = liveLeases(slot.dir);
        if (live.length)
          throw refuse(
            409,
            `players/install: ${slot.name} holds a running player (pid ${live.map((l) => l.pid).join(", ")}); end it or use the other peer's slot`,
          );
        plainSlot(slot, false);
        for (const n of fs.readdirSync(slot.dir))
          if (n.startsWith("trash-"))
            await d.removeTree(path.join(slot.dir, n)).catch(() => undefined);
        if (fs.existsSync(dst)) {
          const trash = path.join(slot.dir, `trash-${now()}-${process.pid}`);
          try {
            fs.renameSync(dst, trash);
          } catch (e) {
            throw refuse(
              409,
              `players/install: ${slot.name}'s player folder is in use (${(e as Error).message})`,
            );
          }
          await d.removeTree(trash).catch(() => undefined);
        }
        const marker: PlayersMarker = {
          sha,
          fingerprint,
          state: "filling",
          source: src,
          lands,
          entry,
          filled: now(),
          used: now(),
          broker: true,
        };
        writeJson(path.join(slot.dir, "slot.json"), marker);
        const t0 = now();
        try {
          plainSlot(slot, false);
          if (lands) {
            fs.mkdirSync(dst);
            await d.copy(src, path.join(dst, lands), { links: "refuse" });
          } else await d.copy(src, dst, { links: "refuse" });
          for (const r of RUNTIME_FILES)
            fs.rmSync(path.join(lands ? path.join(dst, lands) : dst, r), {
              force: true,
            });
        } catch (e) {
          await d.removeTree(dst).catch(() => undefined);
          fs.rmSync(path.join(slot.dir, "slot.json"), { force: true });
          throw refuse(
            500,
            `players/install: copying ${src} into ${slot.name} failed: ${(e as Error).message.split("\n")[0]}`,
          );
        }
        marker.state = "ready";
        plainSlot(slot, false);
        writeJson(path.join(slot.dir, "slot.json"), marker);
        d.log(
          `players broker: ${c.session} installed ${src} into ${slot.name} in ${((now() - t0) / 1000).toFixed(1)} s (w5615)`,
        );
        return {
          slot: slot.name,
          slotDir: slot.dir,
          player: path.join(dst, entry),
          filled: true,
          build: fingerprint,
        };
      }),

    "players/launch": (c, b) =>
      serial(async () => {
        const slot = slotOf(c, b);
        plainSlot(slot, false);
        const m = readMarker(slot.dir);
        if (!m?.broker || m.state !== "ready")
          throw refuse(
            409,
            `players/launch: ${slot.name} holds no build the broker installed; players/install first`,
          );
        const args = b.args === undefined ? [] : b.args;
        if (
          !Array.isArray(args) ||
          args.length > MAX_ARGS ||
          !args.every(
            (a) =>
              typeof a === "string" && a.length <= MAX_ARG && !a.includes("\0"),
          )
        )
          throw refuse(
            400,
            `players/launch: args is a list of at most ${MAX_ARGS} strings`,
          );
        const top = path.join(slot.dir, "player", m.entry);
        if (!fs.existsSync(top))
          throw refuse(
            409,
            `players/launch: ${top} is gone; players/install again`,
          );
        // L1: one running player per slot (it shares the slot's automation config and status file).
        const running = liveLeases(slot.dir);
        if (running.length)
          throw refuse(
            409,
            `players/launch: ${slot.name} already runs a player (pid ${running.map((l) => l.pid).join(", ")}); end it or use the other peer's slot`,
          );
        if (linkIn(path.join(slot.dir, "player")))
          throw refuse(409, `players/launch: ${slot.name}'s player holds a link now; players/install again (w6212)`);
        const exe = m.entry.endsWith(".app") ? bundleExe(top) : top;
        // The game reads its automation config from the folder above its data folder: the exe's folder, or the .app.
        const projectRoot = m.entry.endsWith(".app") ? top : path.dirname(top);
        if (b.config !== undefined) {
          if (typeof b.config !== "string" || b.config.length > MAX_CONFIG)
            throw refuse(
              400,
              `players/launch: config is the automation config's JSON text, at most ${MAX_CONFIG} bytes`,
            );
          try {
            JSON.parse(b.config);
          } catch {
            throw refuse(400, "players/launch: config is not JSON");
          }
          writeNew(path.join(projectRoot, AUTOMATION_CONFIG), b.config);
        } else
          fs.rmSync(path.join(projectRoot, AUTOMATION_CONFIG), { force: true });
        const r = await d.launch({
          exe,
          args: args as string[],
          cwd: path.dirname(exe),
          slotDir: slot.dir,
          sandbox: slot.sandbox,
          session: c.session,
          ...logDirOf(args as string[], ownTemp(c)),
        });
        if ("refused" in r) throw refuse(503, `players/launch: ${r.refused}`);
        const t = now();
        const lease = path.join(
          slot.dir,
          "leases",
          `${d.host}-${r.pid}-${randomBytes(4).toString("hex")}.json`,
        );
        writeJson(lease, {
          pid: r.pid,
          host: d.host,
          sandbox: d.sandboxPath(slot.sandbox) ?? slot.sandbox,
          sha: m.sha,
          build: m.fingerprint,
          time: t / 1000,
          when: new Date(t).toISOString().slice(0, 19),
          session: c.session,
          broker: true,
        });
        m.used = t;
        writeJson(path.join(slot.dir, "slot.json"), m);
        d.log(
          `players broker: ${c.session} started ${exe} in ${slot.name} as pid ${r.pid} (w5615)`,
        );
        return {
          pid: r.pid,
          exe,
          lease,
          slot: slot.name,
          build: m.fingerprint,
        };
      }),

    "players/release": (c, b) => {
      if (!okSandboxId(c.sandbox))
        throw refuse(403, "players: only a sandbox worker has player slots");
      if (typeof b.lease !== "string")
        throw refuse(
          400,
          "players/release: lease is the path players/launch answered",
        );
      const name = path.basename(b.lease);
      for (const peer of [0, 1]) {
        const f = path.join(players, `${c.sandbox}-${peer}`, "leases", name);
        if (path.resolve(b.lease) !== path.resolve(f) || !fs.existsSync(f))
          continue;
        let session: string | undefined;
        try {
          session = (
            JSON.parse(fs.readFileSync(f, "utf8")) as { session?: string }
          ).session;
        } catch {
          // unreadable: the caller's own slot, so it may go
        }
        if (session && session !== c.session)
          throw refuse(
            403,
            "players/release: another session holds that lease",
          );
        fs.rmSync(f, { force: true });
        return { had: true };
      }
      return { had: false };
    },
  };
}

/** The environment a broker-started player gets: no credential (editorEnv.ts's rule), the display, the sandbox's data root. */
export const PLAYER_DISPLAY_ENV = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XAUTHORITY",
  "LANG",
  "LC_ALL",
  "SHELL",
  "LOGNAME",
  "PULSE_SERVER",
  "TMPDIR",
];

/** The -logFile folder of a launch when it lies in the caller's own temp folder `own` (M1: not another session's), else nothing. */
export function logDirOf(args: string[], own: string): { logDir?: string } {
  const i = args.findIndex((a) => a.toLowerCase() === "-logfile");
  const f = i >= 0 ? args[i + 1] : undefined;
  if (!f || !path.isAbsolute(f)) return {};
  const dir = real(path.dirname(f));
  return inside(dir, real(own)) ? { logDir: dir } : {};
}
