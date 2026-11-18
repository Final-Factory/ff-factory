// Whether a worker root install set up the portal's ssh (w4674), for the daemon's hello.
import path from 'node:path';
import { readJson } from './selfUpdate.ts';

/**
 * Whether the worker installer set up the portal's ssh on this computer: root.json's outside list records the portal's
 * key it authorized (scripts/worker/worker.ts planUpdate reads the same entry). A join with -NoSsh (w1596) adds none, so
 * port 22 there is closed by design. Undefined when root.json is missing or unreadable: the portal then keeps what it knew.
 */
export function installHasSsh(root: string): boolean | undefined {
  const m = readJson<{ outside?: { kind?: string }[] }>(path.join(root, 'root.json'));
  return Array.isArray(m?.outside) ? m.outside.some((x) => x?.kind === 'authorized-key') : undefined;
}

/** The hello's layout field (w4674): `ssh` when root.json says, nothing when it does not, so the portal keeps what it knew. */
export function installSshOf(root: string): { ssh?: boolean } {
  const ssh = installHasSsh(root);
  return ssh === undefined ? {} : { ssh };
}
