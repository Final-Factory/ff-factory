// The portal settings `fffctl conf` reaches (w1538, lothsahn: "Those two new settings should be something the new setting
// tool can change"). fffctl conf (w1537) reads and changes /etc/fff/fff.conf, the VM scripts' shell settings; these are
// config.json keys that only the portal reads, so fffctl hands them to this script, run as the portal's account in the
// current release: the same check and write as set_app_config (setAppConfig: config.json.prev kept, a temp file and a
// rename). Only the keys in CONF_PORTAL_KEYS, each a number, so no value here is a secret; any other key is refused
// without its value echoed. The running portal reads config.json at its start, so a change takes effect then.
//   node server/appConfigCli.ts get [KEY]
//   node server/appConfigCli.ts set KEY VALUE        ('' or default: back to the default)
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { configPath, type Config } from './config.ts';
import { normalizeSetting, setAppConfig, type SettableKey } from './appConfig.ts';
import { QUIET_COMPACT_DEFAULTS } from './autoCompact.ts';

/** The config.json keys fffctl conf may read and change, with the default the portal uses when the key is absent. */
export const CONF_PORTAL_KEYS: Record<string, number> = {
  'orchestrator.compactIdleSeconds': QUIET_COMPACT_DEFAULTS.idleSeconds,
  'orchestrator.compactHardAtTokens': QUIET_COMPACT_DEFAULTS.hardAtTokens,
};

/** When a change takes effect (fffctl conf prints it after the change). */
export const CONF_PORTAL_WHEN = "at the portal's next start (a deploy, or fffctl restart); nothing restarts";

class Refused extends Error {}

function readRaw(file: string): Record<string, unknown> {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as Record<string, unknown>;
}

function stored(raw: Record<string, unknown>, key: string): unknown {
  let v: unknown = raw;
  for (const part of key.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
  return v;
}

function checkKey(key: string): void {
  if (!Object.hasOwn(CONF_PORTAL_KEYS, key)) throw new Refused(`conf: ${/^[A-Za-z][A-Za-z0-9.]{0,80}$/.test(key) ? key : 'that key'} is not a portal setting fffctl conf may read or change (it may: ${Object.keys(CONF_PORTAL_KEYS).join(', ')})`);
}

/** `KEY=VALUE (default | set in FILE)`, one line per key: every portal key, or the one asked for. */
export function confGet(file: string, key?: string): string[] {
  if (key !== undefined) checkKey(key);
  const raw = readRaw(file);
  return (key !== undefined ? [key] : Object.keys(CONF_PORTAL_KEYS)).map((k) => {
    const v = stored(raw, k);
    return typeof v === 'number' ? `${k}=${v} (set in ${file})` : `${k}=${CONF_PORTAL_KEYS[k]} (default)`;
  });
}

/**
 * Change one portal key through setAppConfig's check: one line, `KEY: OLD -> NEW (takes effect ...)`, or `KEY: no change`.
 * Throws (nothing written, the value not echoed) on a key it may not change or a value set_app_config refuses.
 */
export function confSet(file: string, key: string, value: string): string {
  checkKey(key);
  const toDefault = value === '' || value === 'default';
  let next: unknown;
  try {
    next = toDefault ? undefined : normalizeSetting(key as SettableKey, value);
  } catch (e) {
    throw new Refused(`conf set ${key}: ${(e as Error).message} (nothing changed)`);
  }
  const before = stored(readRaw(file), key);
  const show = (v: unknown) => (typeof v === 'number' ? String(v) : `${CONF_PORTAL_KEYS[key]}, the default`);
  if (before === next || (typeof before !== 'number' && next === undefined)) return `${key}: no change (${show(before)})`;
  // The live half of setAppConfig changes this process's copy only; the portal reads the file at its start.
  setAppConfig(file, { orchestrator: {} } as unknown as Config, key as SettableKey, toDefault ? null : next);
  return `${key}: ${show(before)} -> ${show(next)} (takes effect ${CONF_PORTAL_WHEN}; the file before is ${file}.prev)`;
}

function main(argv: string[]): number {
  const [what, key, value, ...extra] = argv;
  try {
    if (what === 'get' && value === undefined) {
      for (const line of confGet(configPath(), key)) console.log(line);
      return 0;
    }
    if (what === 'set' && key !== undefined && value !== undefined && !extra.length) {
      console.log(confSet(configPath(), key, value));
      return 0;
    }
    console.error('usage: node server/appConfigCli.ts get [KEY] | set KEY VALUE');
    return 2;
  } catch (e) {
    // Not the error's own text otherwise: a JSON parse error quotes the file, which may hold a secret.
    console.error(e instanceof Refused ? e.message : `conf: could not read or write ${configPath()} (${(e as NodeJS.ErrnoException).code ?? (e as Error).name})`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
