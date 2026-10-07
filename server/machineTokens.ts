import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkStringMap, readJsonDurable, writeJsonDurable } from './durable.ts';

/**
 * Each machine's credential (its enrollment credential, docs/vault.md section 3, and docs/machines.md "Auth"): a 256-bit
 * token the daemon presents on /machine, kept here only as its SHA-256. Its own module, so `fffctl machine-credential`
 * (server/vaultCli.ts) can issue and revoke one while the portal runs without loading the portal. Both writers take the
 * same lock (withFileLock), so neither loses the other's change.
 */

/** A machine id (server/machines.ts re-exports it). */
export const MACHINE_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;

export const tokenSha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Run `fn` holding `<file>.lock` (created exclusively; one left by a crash is stale after 10 s). For files the portal and
 * fffctl both read, change and write: the vault and the machine credentials.
 */
export function withFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd: number | undefined;
  for (let i = 0; i < 50 && fd === undefined; i++) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { force: true });
      } catch {
        // gone meanwhile
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  if (fd === undefined) throw new Error(`${path.basename(file)} is locked by another writer (${lock})`);
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

/**
 * Write JSON atomically, mode 0600. `owner`: a folder whose owner gets the file when root writes it (fffctl, for the
 * portal's user): the temp file is given away before the rename, so the portal never meets a file it cannot read.
 */
export function writeJsonOwned(file: string, value: unknown, owner?: string, generations?: number) {
  if (!owner || process.getuid?.() !== 0) return writeJsonDurable(file, value, { indent: 2, mode: 0o600, generations });
  const st = fs.statSync(owner);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chownSync(tmp, st.uid, st.gid);
  const fd = fs.openSync(tmp, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** Where each machine's credential hash is kept. */
export const machineTokensFile = (dataDir: string) => path.join(dataDir, 'machine-tokens.json');
export const readMachineTokens = (file: string) => readJsonDurable<Record<string, string>>(file, { check: checkStringMap, mode: 0o600 }) ?? {};

/**
 * A fresh credential for machine `id`, returned once: only its hash is kept, replacing the one before (a daemon still
 * connected with that one is dropped, MachineManager.dropRevoked). `add_machine` and `fffctl machine-credential issue`
 * both mint it here. `owner`: see writeJsonOwned.
 */
export function issueMachineToken(dataDir: string, id: string, owner?: string): string {
  if (!MACHINE_ID.test(id)) throw new Error(`machine id "${id}" must be lower-case letters, digits and dashes`);
  const token = newMachineToken(id);
  const file = machineTokensFile(dataDir);
  withFileLock(file, () => {
    const t = readMachineTokens(file);
    t[id] = tokenSha(token);
    delete t[stagedKey(id)];
    writeJsonOwned(file, t, owner);
  });
  return token;
}

const newMachineToken = (id: string) => `ffm_${id}_${randomBytes(32).toString('base64url')}`;

/** Where a deploy's new credential for machine `id` waits (w568): a key no machine id can be (MACHINE_ID has no ':'). */
export const stagedKey = (id: string) => `next:${id}`;

/**
 * A deploy's new credential for machine `id` (w568), returned once, kept BESIDE the current one rather than replacing
 * it: both open the portal until the machine shows which one it has (promoteStagedToken, dropStagedToken). Replacing it
 * up front locked a machine out when the deploy's ssh step failed: the machine kept the old token, the portal only knew
 * the new one, and the daemon's next reconnect was refused (found in w513).
 */
export function stageMachineToken(dataDir: string, id: string, owner?: string): string {
  if (!MACHINE_ID.test(id)) throw new Error(`machine id "${id}" must be lower-case letters, digits and dashes`);
  const token = newMachineToken(id);
  const file = machineTokensFile(dataDir);
  withFileLock(file, () => {
    const t = readMachineTokens(file);
    t[stagedKey(id)] = tokenSha(token);
    writeJsonOwned(file, t, owner);
  });
  return token;
}

/** The staged credential becomes machine `id`'s only one (its daemon connected with it). False when none was staged. */
export function promoteStagedToken(dataDir: string, id: string, owner?: string): boolean {
  const file = machineTokensFile(dataDir);
  return withFileLock(file, () => {
    const t = readMachineTokens(file);
    const next = t[stagedKey(id)];
    if (!next) return false;
    t[id] = next;
    delete t[stagedKey(id)];
    writeJsonOwned(file, t, owner);
    return true;
  });
}

/** Forget machine `id`'s staged credential (the machine never got it, or kept the old one). False when none was staged. */
export function dropStagedToken(dataDir: string, id: string, owner?: string): boolean {
  const file = machineTokensFile(dataDir);
  return withFileLock(file, () => {
    const t = readMachineTokens(file);
    if (!(stagedKey(id) in t)) return false;
    delete t[stagedKey(id)];
    writeJsonOwned(file, t, owner);
    return true;
  });
}

/** Revoke machine `id`'s credential: its daemon is refused from now on, and a connected one is dropped (MachineManager.dropRevoked). */
export function revokeMachineToken(dataDir: string, id: string, owner?: string): boolean {
  const file = machineTokensFile(dataDir);
  return withFileLock(file, () => {
    const t = readMachineTokens(file);
    if (!(id in t) && !(stagedKey(id) in t)) return false;
    delete t[id];
    delete t[stagedKey(id)];
    writeJsonOwned(file, t, owner);
    return true;
  });
}

/** The machines that hold a credential now. */
export const enrolledMachines = (dataDir: string) => Object.keys(readMachineTokens(machineTokensFile(dataDir))).filter((k) => MACHINE_ID.test(k)).sort();
