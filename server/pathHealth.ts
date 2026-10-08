// The path from the internet through Tailscale Funnel to this portal, as the FFBox host's watchdog reports it (w681).
//
// The watchdog (fff-vm watch, deploy/vm/host/pathwatch.sh) runs on the FFBox host, outside this VM, and checks every layer
// from the internet to the portal once a minute: tailscaled, the node's tag, the Serve/Funnel route, the certificate, the
// VM's firewall, the tailnet policy, the Funnel servers, and a request from outside. What it cannot fix, or its repair did
// not fix, it writes into a file in this VM (root-owned, world-readable, no secrets: the watchdog removes keys and login
// links from every line). This module reads that file, and the dashboard's banner and system_status show what it says, so
// people on the tailnet see the problem even while Funnel (the only way in from outside) is down, and the orchestrators can
// tell their person. A problem the portal has not seen before also goes to the host guard's channel (a push notification and
// a message to the orchestrator), once, and again when it clears.

import fs from 'node:fs';
import type { PathHealth, PathLayer } from '../shared/types.ts';

/** Where fff-vm watch puts the file in the VM (fff-vm.conf PW_HEALTH_FILE); FFF_PATH_HEALTH_FILE overrides it here. */
export const PATH_HEALTH_FILE = '/run/fff/path-health.json';
/** The watchdog runs every minute: silent for this long, what the file says may be old. */
export const SILENT_AFTER_MS = 30 * 60_000;

const VERDICTS = new Set(['ok', 'warn', 'fail', 'skip', 'none']);

const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 700) : '');

function layerOf(v: unknown): PathLayer | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  if (!id) return undefined;
  const verdict = str(o.verdict);
  return {
    id,
    name: str(o.name) || id,
    verdict: (VERDICTS.has(verdict) ? verdict : 'none') as PathLayer['verdict'],
    since: str(o.since),
    checkedAt: str(o.checkedAt),
    line: str(o.line),
    who: str(o.who),
    repair: str(o.repair),
  };
}

/**
 * The watchdog's file as a PathHealth, or undefined when it is not one (a half-written file, another schema). `now` is
 * the clock for the silent-watchdog check.
 */
export function parsePathHealth(text: string, now: number): PathHealth | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (o.schema !== 1 || typeof o.updatedAt !== 'string' || !Array.isArray(o.problems)) return undefined;
  const list = (v: unknown): PathLayer[] => (Array.isArray(v) ? v.map(layerOf).filter((l): l is PathLayer => !!l) : []);
  const problems = list(o.problems);
  const updated = Date.parse(o.updatedAt);
  const silent = Number.isFinite(updated) && now - updated > SILENT_AFTER_MS ? Math.round((now - updated) / 60_000) : undefined;
  return {
    updatedAt: o.updatedAt,
    host: str(o.host),
    dns: str(o.dns),
    // A silent watchdog proves nothing about the problems it listed, nor their absence.
    ok: silent === undefined && problems.length === 0,
    problems: silent === undefined ? problems : [],
    warnings: list(o.warnings),
    ...(silent !== undefined ? { silentMinutes: silent } : {}),
  };
}

/** What a banner says about one problem: the layer, since when, the evidence, and who must act. */
export function describeProblem(p: PathLayer): string {
  return `${p.name} (layer ${p.id}) has failed${p.since ? ` since ${p.since.replace('T', ' ').replace(/:\d\dZ$/, 'Z')}` : ''}: ${p.line}${p.repair ? ` Last repair: ${p.repair}.` : ''} Who must act: ${p.who || 'see the watchdog'}.`;
}

export interface PathHealthDeps {
  /** The file's text, or undefined when there is none. */
  read: () => string | undefined;
  now: () => number;
  /** What the banner shows changed (undefined: nothing to show). */
  changed: (h: PathHealth | undefined) => void;
  /** A problem appeared or cleared: a push notification and a message to the orchestrator (server/index.ts). */
  report: (title: string, body: string) => void;
  log: (line: string) => void;
}

/** Reads the watchdog's file, keeps the last status, and reports changes. */
export class PathHealthMonitor {
  private last: PathHealth | undefined;
  /** Problems and silences already reported: "<layer id>@<since>" and "silent". */
  private reported = new Set<string>();
  private signature = '';
  /** The first read only notes what is already wrong: a standing problem is not announced again at every restart. */
  private primed = false;

  private readonly deps: PathHealthDeps;

  constructor(deps: PathHealthDeps) {
    this.deps = deps;
  }

  get status(): PathHealth | undefined {
    return this.last;
  }

  /** Read the file once. Called every few seconds. */
  tick(): void {
    let text: string | undefined;
    try {
      text = this.deps.read();
    } catch (e) {
      this.deps.log(`path health: cannot read the watchdog's file: ${e instanceof Error ? e.message : String(e)}`);
    }
    const h = text === undefined ? undefined : parsePathHealth(text, this.deps.now());
    this.last = h;
    this.reportChanges(h);
    // What the banner shows: problems and a silent watchdog, not the clock ticking in updatedAt.
    const shown = h && (h.problems.length || h.silentMinutes !== undefined) ? h : undefined;
    const sig = shown ? JSON.stringify([shown.silentMinutes !== undefined, shown.problems.map((p) => [p.id, p.since, p.line, p.repair])]) : '';
    if (sig !== this.signature) {
      this.signature = sig;
      this.deps.changed(shown);
    }
  }

  private reportChanges(h: PathHealth | undefined): void {
    const now = new Set<string>();
    if (h) {
      for (const p of h.problems) now.add(`${p.id}@${p.since}`);
      if (h.silentMinutes !== undefined) now.add('silent');
    }
    if (!this.primed) {
      this.primed = true;
      for (const key of now) this.reported.add(key);
      if (now.size) this.deps.log(`path health: already reported by the watchdog at start: ${[...now].join(', ')}`);
      return;
    }
    for (const key of now) {
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      if (key === 'silent') {
        this.deps.report(
          'The VM watchdog is silent',
          `The FFBox host's watchdog (fff-vm watch) has not reported for ${h?.silentMinutes} minutes, so nobody is checking the path from the internet to this portal. Look: sudo fff-vm watch status on the FFBox host.`,
        );
        continue;
      }
      const p = h!.problems.find((x) => `${x.id}@${x.since}` === key)!;
      this.deps.report(`Portal path problem: ${p.name}`, describeProblem(p));
    }
    for (const key of [...this.reported]) {
      if (now.has(key)) continue;
      this.reported.delete(key);
      this.deps.report(key === 'silent' ? 'The VM watchdog reports again' : 'Portal path problem cleared', key === 'silent' ? 'The FFBox host\'s watchdog is reporting again.' : `Layer ${key.split('@')[0]} passes again.`);
    }
  }

  /** The lines system_status adds: the verdict, every problem in full (who must act), and the warnings. */
  statusLines(): string[] {
    const h = this.last;
    if (!h) return [];
    const out: string[] = [];
    if (h.silentMinutes !== undefined) {
      out.push(`WARNING: Portal path watchdog (fff-vm watch on ${h.host || 'the FFBox host'}) has been silent for ${h.silentMinutes} min: nobody is checking the path from the internet to this portal. Last report ${h.updatedAt}.`);
    } else if (h.problems.length === 0) {
      out.push(`Portal path (internet → Funnel${h.dns ? ` → https://${h.dns}` : ''} → portal): every layer passes (fff-vm watch on ${h.host || 'the FFBox host'}, ${h.updatedAt})${h.warnings.length ? `; ${h.warnings.length} warning(s)` : ''}.`);
    } else {
      out.push(`PROBLEM: the portal's path from the internet is broken (fff-vm watch on ${h.host || 'the FFBox host'}, ${h.updatedAt}). Tell your person:`);
      for (const p of h.problems) out.push(`  - ${describeProblem(p)}`);
    }
    for (const w of h.warnings) out.push(`  warning: ${w.name} (layer ${w.id}): ${w.line}`);
    return out;
  }
}

/** The monitor for a file on this machine. */
export function filePathHealth(file: string): () => string | undefined {
  return () => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  };
}
