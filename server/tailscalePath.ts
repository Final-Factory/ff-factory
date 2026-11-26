/**
 * The Tailscale path to a machine when its update bundle runs slow (w5897, from w5643). w5643 could not tell whether the
 * portal's peer for BEAST was direct or relayed during a 25-50 KB/s window: on a Windows worker `tailscale status` and
 * `tailscale ping` need an admin (the local API pipe is admin-only). The portal VM's own tailscaled answers its local users,
 * so when a bundle is cut or runs below SLOW_BUNDLE_KBPS the portal runs two read-only commands there and writes one
 * journal line: `tailscale status --json` (that peer's CurAddr, Relay, LastHandshake, RxBytes, TxBytes) and
 * `tailscale ping -c 5 <the machine's tailnet IP>`. Nothing here changes Tailscale or the update path. docs/portal-logs.md,
 * "The Tailscale path of a slow bundle".
 */

export type Run = (cmd: string, args: string[], o: { timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr?: string; timedOut?: boolean }>;

/** A bundle below this rate is slow (lothsahn, w5897: "below about 200 KB/s"). */
export const SLOW_BUNDLE_KBPS = 200;
/** Only a transfer this long, or this large, is judged on its rate: the small incremental bundles go out in under a second
 * and their rate is mostly the connection's set-up (journal, 2026-11-26: "went out in 0.4 s (3 KB/s)"). */
export const SLOW_JUDGE_MS = 5_000;
export const SLOW_JUDGE_BYTES = 1024 * 1024;
/** A transfer still running after this long at a slow rate is probed while it runs, not only when it ends. */
export const MID_TRANSFER_CHECK_MS = 60_000;
/** At most one probe per machine in this long (a cut, its retry and the mid-transfer check would otherwise each run one). */
export const PROBE_COOLDOWN_MS = 2 * 60_000;

export interface BundleRun { start: number; sent: number; size: number; ms: number; finished: boolean }

export const kbps = (sent: number, ms: number) => Math.round(sent / Math.max(ms / 1000, 0.001) / 1024);

/** Why a served bundle calls for a probe, or undefined. */
export function slowBundleReason(d: BundleRun): string | undefined {
  const rate = kbps(d.sent, d.ms);
  if (!d.finished) return `the update bundle was cut after ${d.start + d.sent} of ${d.size} bytes in ${(d.ms / 1000).toFixed(1)} s (${rate} KB/s)`;
  if (rate < SLOW_BUNDLE_KBPS && (d.ms >= SLOW_JUDGE_MS || d.sent >= SLOW_JUDGE_BYTES)) return `the update bundle went out in ${(d.ms / 1000).toFixed(1)} s (${rate} KB/s)`;
  return undefined;
}

/** Why a transfer still running calls for a probe, or undefined. */
export function slowRunningReason(sent: number, ms: number, size: number): string | undefined {
  const rate = kbps(sent, ms);
  return rate < SLOW_BUNDLE_KBPS ? `the update bundle is still going after ${(ms / 1000).toFixed(0)} s, ${sent} of ${size} bytes (${rate} KB/s)` : undefined;
}

/**
 * The short form tailscaled's own log uses for a node key (`[LGjJu]`: the first 5 characters of its base64, key.NodePublic
 * ShortString), so this line matches the `tailscaled` source's lines. A public key, and only 5 characters of it.
 */
export function shortKey(publicKey: string | undefined): string {
  const hex = /^nodekey:([0-9a-f]{64})$/i.exec(publicKey ?? '')?.[1];
  return hex ? `[${Buffer.from(hex, 'hex').toString('base64').slice(0, 5)}]` : '[?]';
}

export interface PeerPath {
  host: string;
  key: string;
  ip: string;
  online: boolean;
  active: boolean;
  curAddr: string;
  relay: string;
  peerRelay: string;
  lastHandshake: string;
  rx: number;
  tx: number;
}

const label = (s: unknown) => String(s ?? '').split('.')[0].toLowerCase();

/** The peer in `tailscale status --json` for a machine: the one holding its address, else the one named like it. */
export function findPeer(statusJson: string, want: { addr?: string; machineId: string }): PeerPath | undefined {
  let st: { Peer?: Record<string, Record<string, unknown>> };
  try {
    st = JSON.parse(statusJson);
  } catch {
    return undefined;
  }
  const peers = Object.values(st.Peer ?? {});
  const ips = (p: Record<string, unknown>) => (Array.isArray(p.TailscaleIPs) ? (p.TailscaleIPs as unknown[]).map(String) : []);
  const id = want.machineId.toLowerCase();
  const p =
    (want.addr ? peers.find((x) => ips(x).includes(want.addr!)) : undefined) ??
    peers.find((x) => label(x.HostName) === id || label(x.DNSName) === id);
  if (!p) return undefined;
  return {
    host: label(p.DNSName) || label(p.HostName),
    key: shortKey(String(p.PublicKey ?? '')),
    ip: ips(p).find((a) => a.includes('.')) ?? ips(p)[0] ?? '',
    online: p.Online === true,
    active: p.Active === true,
    curAddr: String(p.CurAddr ?? ''),
    relay: String(p.Relay ?? ''),
    peerRelay: String(p.PeerRelay ?? ''),
    lastHandshake: String(p.LastHandshake ?? ''),
    rx: Number(p.RxBytes ?? 0),
    tx: Number(p.TxBytes ?? 0),
  };
}

/** `tailscale ping` output, in a phrase: each pong's path and time, timeouts, and its closing line. */
export function pingSummary(r: { code: number | null; stdout: string; stderr?: string; timedOut?: boolean } | undefined): string {
  if (!r) return 'did not run';
  const lines = `${r.stdout}\n${r.stderr ?? ''}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pongs: string[] = [];
  let timeouts = 0;
  const other: string[] = [];
  for (const l of lines) {
    const m = /^pong from \S+ \([^)]*\) via (.+?) in ([\d.]+\s*m?s)$/.exec(l);
    if (m) pongs.push(`${m[1]} ${m[2]}`);
    else if (/timeout|timed out/i.test(l)) timeouts++;
    else other.push(l);
  }
  const parts: string[] = [];
  if (pongs.length) parts.push(`${pongs.length} pong${pongs.length === 1 ? '' : 's'}: ${pongs.join(', ')}`);
  if (timeouts) parts.push(`${timeouts} timeout${timeouts === 1 ? '' : 's'}`);
  if (other.length) parts.push(`"${other[other.length - 1].slice(0, 200)}"`);
  if (r.timedOut) parts.push('stopped after 40 s');
  parts.push(`exit ${r.code ?? '?'}`);
  return parts.join('; ');
}

const ago = (iso: string, now: number) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t <= 0) return 'never';
  return `${iso.replace(/\.\d+/, '')} (${Math.round((now - t) / 1000)} s ago)`;
};

/** The journal line. `peer` undefined: status had no peer for the machine; `status` says why when it failed. */
export function pathLine(machineId: string, why: string, peer: PeerPath | undefined, status: string, ping: string, now = Date.now()): string {
  const head = `machine ${machineId}: tailscale path, as ${why}:`;
  if (!peer) return `${head} ${status}; ping ${ping}`;
  const path = peer.curAddr ? `direct ${peer.curAddr}` : peer.peerRelay ? `peer relay ${peer.peerRelay}` : `relayed by DERP ${peer.relay || '?'}`;
  return (
    `${head} peer ${peer.host} ${peer.key} ${peer.ip}, ${peer.online ? 'online' : 'OFFLINE'}${peer.active ? ', active' : ''}, ${path} ` +
    `(CurAddr ${peer.curAddr || '-'}, Relay ${peer.relay || '-'}), LastHandshake ${ago(peer.lastHandshake, now)}, ` +
    `RxBytes ${peer.rx}, TxBytes ${peer.tx}; ping ${ping}`
  );
}

/** Runs the two commands at most once per machine per PROBE_COOLDOWN_MS and logs the line. Never throws. */
export class TailscalePathProbe {
  private last = new Map<string, number>();
  private run: Run;
  private log: (line: string) => void;
  private now: () => number;
  constructor(run: Run, log: (line: string) => void = (l) => console.log(l), now: () => number = Date.now) {
    this.run = run;
    this.log = log;
    this.now = now;
  }

  /** Starts a probe unless one for this machine ran within the cooldown; answers the promise (undefined when skipped). */
  probe(machineId: string, why: string, addr?: string): Promise<string> | undefined {
    const t = this.now();
    if (t - (this.last.get(machineId) ?? -Infinity) < PROBE_COOLDOWN_MS) return undefined;
    this.last.set(machineId, t);
    return this.lineFor(machineId, why, addr).then(
      (line) => (this.log(line), line),
      (e) => {
        const line = `machine ${machineId}: tailscale path, as ${why}: the probe failed (${String((e as Error)?.message ?? e).slice(0, 200)})`;
        this.log(line);
        return line;
      },
    );
  }

  private async lineFor(machineId: string, why: string, addr?: string): Promise<string> {
    const st = await this.run('tailscale', ['status', '--json'], { timeoutMs: 10_000 }).catch((e) => ({ code: -1, stdout: '', stderr: String(e?.message ?? e) }));
    const peer = st.code === 0 ? findPeer(st.stdout, { addr, machineId }) : undefined;
    const status =
      st.code !== 0
        ? `tailscale status failed (exit ${st.code}: ${String(st.stderr ?? '').trim().split(/\r?\n/).pop()?.slice(0, 200) ?? ''})`
        : `tailscale status has no peer for ${addr ?? machineId}`;
    const target = peer?.ip || addr;
    const ping = target && /^[0-9a-f:.]+$/i.test(target) ? pingSummary(await this.run('tailscale', ['ping', '-c', '5', target], { timeoutMs: 40_000 }).catch(() => undefined)) : 'not run (no tailnet IP)';
    return pathLine(machineId, why, peer, status, ping, this.now());
  }
}
