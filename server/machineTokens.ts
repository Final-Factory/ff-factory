import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { checkStringMap, readJsonDurable, writeJsonDurable } from './durable.ts';

/**
 * Each machine's credential (its enrollment credential, docs/vault.md section 3, and docs/machines.md "Auth"): a 256-bit
 * token the daemon presents on /machine, kept here only as its SHA-256. Its own module, so `fffctl machine-credential`
 * (server/vaultCli.ts) can issue and revoke one while the portal runs without loading the portal.
 */

/** A machine id (server/machines.ts re-exports it). */
export const MACHINE_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;

export const tokenSha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Where each machine's credential hash is kept. */
export const machineTokensFile = (dataDir: string) => path.join(dataDir, 'machine-tokens.json');
export const readMachineTokens = (file: string) => readJsonDurable<Record<string, string>>(file, { check: checkStringMap, mode: 0o600 }) ?? {};
export const writeMachineTokens = (file: string, t: Record<string, string>) => writeJsonDurable(file, t, { indent: 2, mode: 0o600 });

/** A fresh credential for machine `id`, returned once: only its hash is kept, replacing the one before. `add_machine` and `fffctl machine-credential issue` both mint it here. */
export function issueMachineToken(dataDir: string, id: string): string {
  if (!MACHINE_ID.test(id)) throw new Error(`machine id "${id}" must be lower-case letters, digits and dashes`);
  const token = `ffm_${id}_${randomBytes(32).toString('base64url')}`;
  const file = machineTokensFile(dataDir);
  const t = readMachineTokens(file);
  t[id] = tokenSha(token);
  writeMachineTokens(file, t);
  return token;
}

/** Revoke machine `id`'s credential: its daemon is refused from now on, and a connected one is dropped (MachineManager.dropRevoked). */
export function revokeMachineToken(dataDir: string, id: string): boolean {
  const file = machineTokensFile(dataDir);
  const t = readMachineTokens(file);
  if (!(id in t)) return false;
  delete t[id];
  writeMachineTokens(file, t);
  return true;
}

/** The machines that hold a credential now. */
export const enrolledMachines = (dataDir: string) => Object.keys(readMachineTokens(machineTokensFile(dataDir))).sort();
