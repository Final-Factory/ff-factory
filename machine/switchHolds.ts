// What holds a sandbox's tree besides its editor, so switch_branch refuses (w3626). On 2026-11-08 the nightly e2e's attempt
// 2 (w3598) was building master f19f2af5 with build_player.sh, a batchmode Unity, in lothdesktop/slot1; at 05:01 EST a
// second worker there (w3610) called switch_branch and it went through, and for about 4 minutes the build's first pass ran
// on another commit's tree (8d668f9, 41 changed files under Assets). A switch is refused now while
//   - a night runs in that checkout: <nightly-history>/state/<tag>.json says status "running" and its builds folder
//     (nightly.sh: "$CLONE/Builds/cache") or checkout is in the sandbox, and its process is alive;
//   - a unity-slot run holds a slot for the sandbox ("sandbox:<id>", the holder the daemon gives its agents) or names
//     its project (--project), or a batchmode Unity has that project open (started outside the gate, it counts all the same).
import fs from 'node:fs';
import path from 'node:path';
import type { UnityPlatform } from './unity.ts';
import type { SlotRequest, UnityProcess } from './unitySlots.ts';

/** A night's state file (the game repo's scripts/nightly/watchdog.py cmd_state), the fields read here. */
export interface NightState {
  tag?: string;
  date?: string;
  status?: string;
  request?: string;
  attempt?: number;
  step?: string;
  started?: number;
  pid?: number;
  builds?: string;
  checkout?: string;
}

/** A night still marked running after this long is a leftover (a night is 3 to 8 hours), not a holder. */
export const NIGHT_MAX_MS = 36 * 3600_000;

/**
 * A path as one key on any host: backslashes to slashes, Git Bash's /d/... to d:/..., no trailing slash, lower case on
 * Windows. nightly.sh writes its paths through `cygpath -u`, the daemon its own way.
 */
export function holdKey(p: string, platform: UnityPlatform): string {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (platform === 'win32') {
    s = s.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:').replace(/^\/cygdrive\/([a-zA-Z])(?=\/|$)/, '$1:');
    s = s.toLowerCase();
  }
  return s;
}

const inside = (p: string, dir: string, platform: UnityPlatform) => {
  const a = holdKey(p, platform);
  const b = holdKey(dir, platform);
  return a === b || a.startsWith(`${b}/`);
};

/** The nights running in `checkout`, read from each history folder's state/*.json. */
export function nightsIn(opts: { roots: string[]; checkout: string; platform: UnityPlatform; alive: (pid: number) => boolean; now: number }): (NightState & { file: string })[] {
  const out: (NightState & { file: string })[] = [];
  for (const root of opts.roots) {
    const dir = path.join(root, 'state');
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    } catch {
      continue;
    }
    for (const n of names) {
      let st: NightState;
      try {
        st = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as NightState;
      } catch {
        continue;
      }
      if (!st || st.status !== 'running') continue;
      const where = typeof st.checkout === 'string' && st.checkout ? st.checkout : typeof st.builds === 'string' && st.builds ? st.builds : undefined;
      if (!where || !inside(where, opts.checkout, opts.platform)) continue;
      // A night whose shell is gone (TerminateProcess, a crash) may stay "running" in its file: it holds nothing.
      if (typeof st.pid === 'number' && st.pid > 0 && !opts.alive(st.pid)) continue;
      if (typeof st.started === 'number' && opts.now - st.started * 1000 > NIGHT_MAX_MS) continue;
      out.push({ ...st, file: path.join(dir, n) });
    }
  }
  return out;
}

/** The granted unity-slot runs that hold slots for the sandbox `id` or name its project. */
export function slotRunsFor(reqs: SlotRequest[], id: string, checkout: string, platform: UnityPlatform): SlotRequest[] {
  return reqs.filter((r) => r.grantedAt !== undefined && !r.denied && (r.holder === `sandbox:${id}` || (r.projects ?? []).some((p) => inside(p, checkout, platform))));
}

/** Batchmode Unity processes with the sandbox's project open. */
export function batchUnityIn(procs: UnityProcess[], checkout: string, platform: UnityPlatform): UnityProcess[] {
  return procs.filter((u) => u.kind === 'batch' && u.project && holdKey(u.project, platform) === holdKey(checkout, platform));
}

const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);

/** The refusal naming every holder, or undefined when none holds the tree. */
export function switchHoldRefusal(id: string, h: { nights: NightState[]; runs: SlotRequest[]; batch: UnityProcess[] }): string | undefined {
  const parts: string[] = [];
  for (const n of h.nights) {
    const since = typeof n.started === 'number' ? ` since ${hhmm(n.started * 1000)} UTC` : '';
    parts.push(`the nightly run of ${n.date ?? n.tag ?? 'an unknown date'} (request ${n.request || 'unknown'}${n.attempt ? `, attempt ${n.attempt}` : ''}${n.step ? `, step ${n.step}` : ''}) runs in it${since}${n.pid ? `, pid ${n.pid}` : ''}`);
  }
  const counted = new Set<number>();
  for (const r of h.runs) {
    counted.add(r.pid);
    parts.push(`the unity-slot run "${r.label}" holds ${r.count} Unity slot(s) for it (holder ${r.holder}${r.session ? `, session ${r.session}` : ''}, pid ${r.pid}${r.grantedAt !== undefined ? `, since ${hhmm(r.grantedAt)} UTC` : ''})`);
  }
  const loose = h.batch.filter((u) => !counted.has(u.ppid) && !counted.has(u.pid));
  if (loose.length && !h.runs.length) parts.push(`a batchmode Unity has its project open (pid ${loose.map((u) => u.pid).join(', ')})`);
  if (!parts.length) return undefined;
  return `switch refused: ${parts.join('; ')}. A switch now would change the tree under that build (w3626: on 2026-11-08 one moved a nightly's build in lothdesktop/slot1 onto another commit). Wait until it ends (wake_me), then switch; nothing was switched.`;
}
