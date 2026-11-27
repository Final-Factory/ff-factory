/**
 * w4258: the stale build output of a cargo target, found the way cargo itself links units, so a warm target stays warm.
 *
 * Cargo never deletes what an older build left (w3396): every feature set, profile and dependency change makes a new unit
 * (`<crate>-<16 hex>` in deps/, build/, incremental/ and .fingerprint/), and the old one stays. lothsahn, w4258: the four ffu
 * slots on LothDesktop held 28, 19, 27 and 9.7 GB, and the clean-up's only tools were the incremental cache and the whole
 * target (a cold build: 221 s on BEAST, docs/ffu-sandboxes.md).
 *
 * A mark and sweep over cargo's own records. Each unit's `.fingerprint/<pkg>-<hash>/<kind>.json` lists the fingerprints of
 * the units it was built from (`deps: [[id, name, public, fingerprint]]`), and the unit's `<kind>` file holds its own
 * fingerprint as 16 hex digits (the u64's little-endian bytes). The roots are the workspace's own units (their `local`
 * holds a CheckDepInfo: a crate built from a checkout, not a registry) built within `keepHours` of the newest one, the newest
 * executable of each name in deps/ (the test binaries and bins of the latest build, however old: w6240), plus any unit a
 * running process names (a test binary still running). Everything those reach stays, however old (a dependency
 * built once on day one is current). What no root reaches goes, unless it was written within `settleMs`.
 *
 * On macOS, rustc keeps a unit's codegen objects (`<unit>.<cgu>.rcgu.o`) in deps/ for debug info, and every rebuild of a
 * unit leaves new ones beside the old (measured, m5 ffu slot3, 2026-11-14: 2.86 GB of superseded objects in an 11.5 GB
 * debug folder). An object goes when it has one link (an incremental build hard-links the objects it reuses, which keep
 * their old time) and is older than `objectGraceMs` before its unit's newest other artifact.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface CargoSweepOptions {
  /** Workspace units built within this many hours of the newest one are roots. */
  keepHours: number;
  /** Command lines of processes running from the target (a test binary): every unit hash they name is a root too. */
  pinned?: string[];
  /** Nothing written within this long before `now` goes. */
  settleMs: number;
  now: number;
  /** An object file goes only when it is older than its unit's newest other artifact by this much (default 10 min). */
  objectGraceMs?: number;
}

export interface CargoSweep {
  /** Entries to delete: stale units' files and folders, superseded object files. */
  paths: string[];
  bytes: number;
  units: number;
  live: number;
  /** How many executables in deps/ were roots as the newest of their name (w6240). */
  executables: number;
  /** How many of `paths` are superseded object files of live units. */
  objects: number;
  /** How many of `bytes` lie in a profile's incremental/ (a trim of debug/incremental takes them anyway). */
  incrementalBytes: number;
}

const HASHED = /^(?:lib)?(.+?)-([0-9a-f]{16})(?=[.-]|$)/;
const UNIT_DIR = /^(.+)-([0-9a-f]{16})$/;
const HASH_DIRS = ['deps', 'build', 'incremental', '.fingerprint', 'examples'];
const HEX16 = /^[0-9a-f]{16}$/;
/** An executable cargo links into deps/: a test binary or a bin, with no extension, or `.exe` on Windows (w6240). */
const EXE = /^(.+)-([0-9a-f]{16})(\.exe)?$/;

const list = async (d: string): Promise<fs.Dirent[]> => fs.promises.readdir(d, { withFileTypes: true }).catch(() => []);
const lstat = (p: string) => fs.promises.lstat(p).catch(() => undefined);

async function bytesOf(p: string): Promise<number> {
  const st = await lstat(p);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of await list(p)) n += await bytesOf(path.join(p, e.name));
  return n;
}

/** The profile folders of a target: each child (debug, release, a custom profile) or grandchild (a target triple's) with a .fingerprint. */
export async function cargoProfiles(target: string): Promise<string[]> {
  const out: string[] = [];
  for (const a of await list(target)) {
    if (!a.isDirectory()) continue;
    const p = path.join(target, a.name);
    if (fs.existsSync(path.join(p, '.fingerprint'))) out.push(p);
    else for (const b of await list(p)) if (b.isDirectory() && fs.existsSync(path.join(p, b.name, '.fingerprint'))) out.push(path.join(p, b.name));
  }
  return out;
}

/** A fingerprint as cargo's `<kind>` file spells it: the u64's little-endian bytes in hex. */
export const fingerprintHex = (n: string | number | bigint): string | undefined => {
  try {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b.toString('hex');
  } catch {
    return undefined;
  }
};

/** The unit hashes a command line names: a running test binary's `deps/<name>-<hash>`. */
const hashesIn = (cmd: string): string[] => [...cmd.matchAll(/-([0-9a-f]{16})(?![0-9a-f])/g)].map((m) => m[1]);

async function sweepProfile(prof: string, o: CargoSweepOptions, out: CargoSweep): Promise<void> {
  const byFingerprint = new Map<string, string>();
  const deps = new Map<string, string[]>();
  const roots = new Map<string, number>();
  for (const u of await list(path.join(prof, '.fingerprint'))) {
    const m = UNIT_DIR.exec(u.name);
    if (!u.isDirectory() || !m) continue;
    const hash = m[2];
    const dir = path.join(prof, '.fingerprint', u.name);
    const unitDeps = deps.get(hash) ?? [];
    deps.set(hash, unitDeps);
    for (const f of await list(dir)) {
      if (!f.isFile()) continue;
      const file = path.join(dir, f.name);
      if (f.name.endsWith('.json')) {
        let j: { deps?: unknown[]; local?: unknown[] } | undefined;
        try {
          // cargo writes each fingerprint as a bare u64, past a double's 2^53: quoted first, so BigInt reads it exactly.
          j = JSON.parse((await fs.promises.readFile(file, 'utf8')).replace(/([:[,]\s*)(\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));
        } catch {
          continue;
        }
        for (const d of Array.isArray(j?.deps) ? j!.deps : []) {
          const hex = Array.isArray(d) ? fingerprintHex(d[3] as string | number) : undefined;
          if (hex) unitDeps.push(hex);
        }
        if ((Array.isArray(j?.local) ? j!.local : []).some((l) => !!l && typeof l === 'object' && 'CheckDepInfo' in (l as object))) {
          const st = await lstat(file);
          roots.set(hash, Math.max(roots.get(hash) ?? 0, st?.mtimeMs ?? 0));
        }
      } else if (!f.name.startsWith('dep-') && f.name !== 'invoked.timestamp') {
        const st = await lstat(file);
        if (!st || st.size > 64) continue;
        const v = (await fs.promises.readFile(file, 'utf8').catch(() => '')).trim();
        if (HEX16.test(v)) byFingerprint.set(v, hash);
      }
    }
  }
  if (!roots.size) return;
  const newest = Math.max(...roots.values());
  const live = new Set<string>();
  const stack = [...roots].filter(([, t]) => t >= newest - o.keepHours * 3_600_000).map(([h]) => h);
  for (const cmd of o.pinned ?? []) for (const h of hashesIn(cmd)) if (deps.has(h)) stack.push(h);
  // w6240: the newest executable of each name in deps/ (a test binary or a bin, `<name>-<hash>`, `.exe` on Windows) is a root
  // however old: the one the latest `cargo test --no-run` or build left. Cargo rewrites no file of a unit that is already up
  // to date, so a test binary whose crate did not change keeps its old time and its fingerprint's, and a window measured from
  // the newest build dropped it while a run was about to start it (biscuit slot4, 2026-11-27: 62 of 257 test binaries at the
  // 15 min window). Rooting its hash keeps its fingerprint, its .d, its .dSYM or .pdb and everything it was built from.
  const newestExe = new Map<string, { hash: string; mtime: number }>();
  for (const e of await list(path.join(prof, 'deps'))) {
    const m = EXE.exec(e.name);
    if (!m || !e.isFile()) continue;
    const st = await lstat(path.join(prof, 'deps', e.name));
    if (!st || (!m[3] && !(st.mode & 0o111))) continue;
    const had = newestExe.get(m[1]);
    if (!had || st.mtimeMs > had.mtime) newestExe.set(m[1], { hash: m[2], mtime: st.mtimeMs });
  }
  for (const { hash } of newestExe.values()) {
    stack.push(hash);
    out.executables++;
  }
  while (stack.length) {
    const h = stack.pop()!;
    if (live.has(h)) continue;
    live.add(h);
    for (const f of deps.get(h) ?? []) {
      const d = byFingerprint.get(f);
      if (d && !live.has(d)) stack.push(d);
    }
  }
  out.units += deps.size;
  out.live += live.size;
  const fresh = o.now - o.settleMs;
  // Superseded objects need each live unit's newest other artifact first.
  const newestOther = new Map<string, number>();
  const objects: { file: string; hash: string; mtime: number; size: number }[] = [];
  for (const sub of HASH_DIRS) {
    const dir = path.join(prof, sub);
    for (const e of await list(dir)) {
      const m = HASHED.exec(e.name);
      if (!m) continue;
      const hash = m[2];
      const p = path.join(dir, e.name);
      const st = await lstat(p);
      if (!st) continue;
      if (!live.has(hash)) {
        if (st.mtimeMs > fresh) continue;
        const b = await bytesOf(p);
        out.paths.push(p);
        out.bytes += b;
        if (sub === 'incremental') out.incrementalBytes += b;
        continue;
      }
      if (sub !== 'deps') continue;
      if (e.name.endsWith('.rcgu.o')) {
        if (st.nlink <= 1) objects.push({ file: p, hash, mtime: st.mtimeMs, size: st.size });
      } else newestOther.set(hash, Math.max(newestOther.get(hash) ?? 0, st.mtimeMs));
    }
  }
  const grace = o.objectGraceMs ?? 10 * 60_000;
  for (const ob of objects) {
    const top = newestOther.get(ob.hash);
    if (!top || ob.mtime > top - grace || ob.mtime > fresh) continue;
    out.paths.push(ob.file);
    out.bytes += ob.size;
    out.objects++;
  }
}

/** What a sweep of `target` would delete (nothing is deleted here). A target with no workspace unit is left alone. */
export async function planCargoSweep(target: string, o: CargoSweepOptions): Promise<CargoSweep> {
  const out: CargoSweep = { paths: [], bytes: 0, units: 0, live: 0, executables: 0, objects: 0, incrementalBytes: 0 };
  for (const prof of await cargoProfiles(target)) await sweepProfile(prof, o, out);
  return out;
}

/**
 * A unit's key as `<crate>-<16 hex>` from the basename of one of its entries (a `deps/lib<crate>-<hash>.rlib`, a
 * `.fingerprint/<crate>-<hash>` folder, `incremental/<crate>-<hash>-<id>`), or undefined for a name with no unit hash (w6291). The
 * `lib` prefix is dropped as the sweep drops it, so a crate whose own name starts with `lib` is named differently by its rlib and
 * its fingerprint folder: compare keys by their last 16 characters, the hash.
 */
export const unitKeyOf = (name: string): string | undefined => {
  const m = HASHED.exec(name);
  return m ? `${m[1]}-${m[2]}` : undefined;
};

/** The units a plan would sweep, one key each (a superseded object file is a live unit's, not a unit swept). */
export function sweptUnits(sweep: CargoSweep): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of sweep.paths) {
    const base = path.basename(p);
    if (base.endsWith('.rcgu.o')) continue;
    const key = unitKeyOf(base);
    if (key && !seen.has(key.slice(-16))) {
      seen.add(key.slice(-16));
      out.push(key);
    }
  }
  return out;
}

/** The hashes of the units a target still has a fingerprint folder for: what a build can reuse (w6291). */
export async function cargoUnitHashes(target: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const prof of await cargoProfiles(target)) {
    for (const u of await list(path.join(prof, '.fingerprint'))) {
      const m = UNIT_DIR.exec(u.name);
      if (u.isDirectory() && m) out.add(m[2]);
    }
  }
  return out;
}
