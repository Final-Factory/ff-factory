import type http from 'node:http';
import { clientAddress } from './clientAddress.ts';
import { tailnetOnly } from './remoteChat.ts';

/**
 * The daemon link (/machine, /machine/live/<id> and every /machine/... HTTP route) from the tailnet only (w5575, finding 3
 * of the w5450 network audit: /machine was reachable from the public internet through Tailscale Funnel).
 *
 * The test is remoteChat's tailnetOnly, the one /mcp and the join already use: a request with Tailscale's Funnel header is
 * refused, then the client address (clientAddress, w5535: the last X-Forwarded-For entry, believed only from a proxy on
 * this machine) must be loopback, 100.64.0.0/10 or fd7a:115c:a1e0::/48. A header from any other peer is ignored.
 *
 * config `machineLinkTailnet` (an owner's setting, set_app_config, read live, no restart):
 * - "warn" (the default while unset): every connection is let in as before; one that would be refused is logged
 *   "machine link: WOULD REFUSE ..." (once per address, path kind and reason per hour);
 * - "enforce": that connection is answered 403 and closed;
 * - "off": no check and no log, the recovery switch (docs/machines.md, "The daemon link is tailnet-only").
 * Each daemon link that opens is also logged with its address ("machine link from <address> ..."), so the portal's log
 * lists what each machine connects from before anyone turns enforce on.
 */
export type MachineLinkMode = 'off' | 'warn' | 'enforce';

export const MACHINE_LINK_MODES: readonly MachineLinkMode[] = ['off', 'warn', 'enforce'];

/** The mode a config value means: unset or unknown is "warn". */
export function machineLinkMode(v: unknown): MachineLinkMode {
  return v === 'off' || v === 'enforce' ? v : 'warn';
}

/** Whether a path is the daemon link's: /machine itself or anything under /machine/. */
export function isMachineLinkPath(pathname: string): boolean {
  return pathname === '/machine' || pathname.startsWith('/machine/');
}

type Req = Pick<http.IncomingMessage, 'headers' | 'socket'>;

export interface MachineLinkVerdict {
  /** The client address the check judged (clientAddress). */
  address: string;
  /** Why it is not from the tailnet, or undefined when it is. */
  why?: string;
  /** Whether to refuse it now (only in "enforce"). */
  refuse: boolean;
}

const WARN_EVERY_MS = 60 * 60_000;
const warned = new Map<string, number>();

/** Check one /machine request or upgrade, and log what "warn" and "enforce" log. `kind` names the route in the log. */
export function checkMachineLink(req: Req, mode: MachineLinkMode, kind: string, log: (line: string) => void = console.warn, now = Date.now()): MachineLinkVerdict {
  if (mode === 'off') return { address: '', refuse: false };
  const address = clientAddress(req);
  const why = tailnetOnly(req, 'the daemon link');
  if (!why) return { address, refuse: false };
  if (mode === 'enforce') {
    log(`machine link: refused ${kind} from ${address}: ${why}`);
    return { address, why, refuse: true };
  }
  const key = `${address}|${kind}|${why}`;
  const last = warned.get(key);
  if (last === undefined || now - last >= WARN_EVERY_MS) {
    if (warned.size > 1000) warned.clear();
    warned.set(key, now);
    log(`machine link: WOULD REFUSE ${kind} from ${address} (machineLinkTailnet is warn, let in): ${why}`);
  }
  return { address, why, refuse: false };
}

/** For tests: forget which warnings were logged. */
export function resetMachineLinkWarnings() {
  warned.clear();
}
