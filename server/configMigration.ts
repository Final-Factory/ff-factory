// w1078: config.json holds no secret, so the owners' orchestrators, the dispatcher and the ops worker may read it.
// Every Claude process runs on a vault token (lothsahn, 2026-10-12: "Delete claudeTokenFile and its associated config.
// Also delete claudeEnv, get rid of the fallback mode, everything runs off the vault"), and FFBox's connector hash lives in
// a file of the secrets folder that config names (lothsahn: "migrate providers.ffbox { enabled, tokenSha256 } to a file in
// the secrets folder and have the config reference the filename"). The portal's start does the change once
// (migrateConfig), keeping the file as it was in the secrets folder, and scrubs config.json's saved versions.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, currentAccounts, pinnedVaultEntry, type Config } from './config.ts';
import { writeFileDurable } from './durable.ts';
import { redactSecrets } from './secrets.ts';

/** The file in the secrets folder that holds FFBox's connector token hash (providers.ffbox.tokenSha256File). */
export const FFBOX_HASH_FILE = 'ffbox-connector-token.sha256';
/** The token file of the retired "tokenfile" account (w464: `fffctl claude-token` wrote it), deleted once vault runs verify. */
export const OLD_TOKEN_FILE = 'claude-oauth-token';
const HASH = /^[0-9a-f]{64}$/;

/**
 * The portal's secrets folder: FFSB_SECRETS_DIR, else the one the read guard already closes (server/secretGuard.ts
 * portalSecretRules): `<app>/secrets` when config.json sits in the app folder, else `secrets` beside config.json's folder
 * (the VM: /srv/fff/config/config.json -> /srv/fff/secrets).
 */
export function secretsDirOf(configFile: string, appRoot = ROOT, env: NodeJS.ProcessEnv = process.env): string {
  if (env.FFSB_SECRETS_DIR) return path.resolve(env.FFSB_SECRETS_DIR);
  const dir = path.dirname(path.resolve(configFile));
  return path.resolve(dir) === path.resolve(appRoot) ? path.join(appRoot, 'secrets') : path.join(path.dirname(dir), 'secrets');
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (text: string): unknown => JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const last4 = (v: unknown) => (typeof v === 'string' && v.length >= 8 ? ` …${v.slice(-4)}` : '');

/**
 * FFBox's connector token hash: from the file config providers.ffbox.tokenSha256File names, read at each call so a new one
 * applies at the connector's next connection; before the start has moved it, the old inline providers.ffbox.tokenSha256.
 * Undefined when there is none, or the file does not hold one hash (never shown).
 */
export function ffboxTokenHash(cfg: Pick<Config, 'providers'>): string | undefined {
  const f = cfg.providers?.ffbox;
  if (f?.tokenSha256File) {
    try {
      const h = fs.readFileSync(f.tokenSha256File, 'utf8').trim();
      return HASH.test(h) ? h : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof f?.tokenSha256 === 'string' && HASH.test(f.tokenSha256) ? f.tokenSha256 : undefined;
}

/** Make the secrets folder (0700) if it is missing. */
function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** A file only its owner reads, owned like `like` when this runs as root (the VM's fffctl): the portal's account then reads it. */
function writeSecret(file: string, text: string, like?: string) {
  ensureDir(path.dirname(file));
  writeFileDurable(file, text, { generations: 0, mode: 0o600 });
  fs.chmodSync(file, 0o600);
  if (like && process.getuid?.() === 0) {
    const st = fs.statSync(like);
    fs.chownSync(file, st.uid, st.gid);
  }
}

/** Store (or with undefined, remove) FFBox's connector token hash in its file; returns the file's path. set_app_config's write. */
export function writeFfboxTokenHash(file: string, hash: string | undefined, like?: string): string {
  if (hash === undefined) fs.rmSync(file, { force: true });
  else {
    if (!HASH.test(hash)) throw new Error('providers.ffbox.token: not a connector token hash (not shown)');
    writeSecret(file, `${hash}\n`, like);
  }
  return file;
}

/** Where a string looks like a credential, by redactSecrets' patterns or a URL with a password: the key paths, never the values. */
function credentialPaths(v: unknown, at: string[] = []): string[] {
  if (typeof v === 'string') return redactSecrets(v) !== v || /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(v) ? [at.join('.') || '(root)'] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => credentialPaths(x, [...at, String(i)]));
  if (isObj(v)) return Object.entries(v).flatMap(([k, x]) => credentialPaths(x, [...at, k]));
  return [];
}

/**
 * What in a config object is a secret, or a key w1078 retired that may hold one: their key paths (never a value). Empty for
 * a config the owners' orchestrators, the dispatcher and the ops worker may read.
 */
export function inlineSecrets(raw: unknown): string[] {
  if (!isObj(raw)) return [];
  const out: string[] = [];
  for (const k of ['claudeEnv', 'userClaudeEnv', 'claudeTokenFile']) if (raw[k] !== undefined) out.push(k);
  if (isObj(raw.providers) && isObj(raw.providers.ffbox) && raw.providers.ffbox.tokenSha256 !== undefined) out.push('providers.ffbox.tokenSha256');
  for (const p of credentialPaths(raw)) if (!out.some((o) => p === o || p.startsWith(`${o}.`))) out.push(p);
  return out;
}

/** What w1078 took out of one config object, and the FFBox hash it held. */
interface Stripped {
  out: Record<string, unknown>;
  /** Each change, safe to log: key paths, a token's last four characters at most. */
  changes: string[];
  hash?: string;
}

/** A config object without the retired account keys and with no inline FFBox hash (pure). */
export function stripConfig(raw: Record<string, unknown>): Stripped {
  const out: Record<string, unknown> = { ...raw };
  const changes: string[] = [];
  if (out.claudeEnv !== undefined) {
    // Its variables by name, a token by its last four characters (w1078: CLAUDE_CONFIG_DIR and the like go with it).
    const vars = isObj(out.claudeEnv) ? Object.entries(out.claudeEnv).map(([k, v]) => (k === 'CLAUDE_CODE_OAUTH_TOKEN' ? `the host token${last4(v)}` : k)) : [];
    changes.push(`claudeEnv${vars.length ? ` (${vars.join(', ')})` : ''}`);
    delete out.claudeEnv;
  }
  if (out.userClaudeEnv !== undefined) {
    const people = isObj(out.userClaudeEnv) ? Object.entries(out.userClaudeEnv).map(([id, e]) => `${id}${last4(isObj(e) ? e.CLAUDE_CODE_OAUTH_TOKEN : undefined)}`) : [];
    changes.push(`userClaudeEnv${people.length ? ` (${people.join(', ')})` : ''}`);
    delete out.userClaudeEnv;
  }
  if (out.claudeTokenFile !== undefined) {
    const v = out.claudeTokenFile;
    // A path is said; anything else is not (w1078: it might hold a token by mistake), only its length.
    changes.push(typeof v === 'string' && path.isAbsolute(v) && !redactSecrets(v).includes('[redacted') ? `claudeTokenFile (${v})` : `claudeTokenFile (not a path: ${typeof v === 'string' ? v.length : 0} characters, not shown)`);
    delete out.claudeTokenFile;
  }
  if (isObj(out.machines) && (out.machines.useHostClaudeEnv !== undefined || out.machines.claudeFromVault !== undefined)) {
    const m = { ...out.machines };
    for (const k of ['useHostClaudeEnv', 'claudeFromVault']) {
      if (m[k] === undefined) continue;
      changes.push(`machines.${k}`);
      delete m[k];
    }
    out.machines = m;
  }
  {
    // The orchestrators get "vault" written out, so a rollback to a release from before w1078 runs them on their pools too.
    // The dispatcher keeps only a pin: "vault" (the payer's pool) is no key, as set_app_config stores it, and those releases
    // refused it.
    const was = isObj(out.claudeAccounts) ? out.claudeAccounts : {};
    const a = currentAccounts(was) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...a, orchestrator: 'vault' };
    if (next.dispatcher !== undefined && pinnedVaultEntry(next.dispatcher as string) === undefined) delete next.dispatcher;
    for (const k of Object.keys(was)) if (!(k in next) || (k === 'orchestrator' && was[k] !== 'vault')) changes.push(`claudeAccounts.${k} ("${String(was[k])}"${k in next ? ' -> "vault"' : ''})`);
    if (!isObj(out.claudeAccounts)) changes.push('claudeAccounts.orchestrator ("vault", written out)');
    if (JSON.stringify(next) !== JSON.stringify(out.claudeAccounts)) out.claudeAccounts = next;
  }
  let hash: string | undefined;
  if (isObj(out.providers) && isObj(out.providers.ffbox) && out.providers.ffbox.tokenSha256 !== undefined) {
    const f = { ...out.providers.ffbox };
    const h = typeof f.tokenSha256 === 'string' ? f.tokenSha256.trim().toLowerCase() : '';
    if (HASH.test(h)) hash = h;
    changes.push(`providers.ffbox.tokenSha256${hash ? '' : ' (not a hash: dropped)'}`);
    delete f.tokenSha256;
    out.providers = { ...out.providers, ffbox: f };
  }
  return { out, changes, hash };
}

export interface ConfigMigration {
  /** What changed in config.json (key paths; a token by its last four characters at most). Empty: it already was. */
  changes: string[];
  /** config.json as it was, in the secrets folder (0600), when it changed. */
  backup?: string;
  /** Saved versions of config.json (.prev, .1, ...) rewritten without their secrets, or moved into the secrets folder. */
  scrubbed: string[];
  /** Key paths whose values still look like credentials (not moved: a person's to fix). */
  warnings: string[];
}

/**
 * The w1078 change of config.json, once (idempotent: a second run changes nothing): the retired account keys out, FFBox's
 * hash into `<secretsDir>/ffbox-connector-token.sha256` with providers.ffbox.tokenSha256File naming it, the file as it was
 * kept in the secrets folder first. Then every saved version beside it (config.json.prev, .1, .2, .3, .tmp, .damaged-…)
 * is rewritten the same way, or moved into the secrets folder when it cannot be read, so none keeps a secret readable.
 */
export function migrateConfig(configFile: string, secretsDir: string, now = new Date()): ConfigMigration {
  const text = fs.readFileSync(configFile, 'utf8');
  const raw = parse(text);
  if (!isObj(raw)) throw new Error(`${configFile} is not a JSON object`);
  const s = stripConfig(raw);
  const res: ConfigMigration = { changes: s.changes, scrubbed: [], warnings: [] };
  if (s.changes.length) {
    const mode = fs.statSync(configFile).mode & 0o777;
    const backup = path.join(secretsDir, `config.json.before-w1078-${now.toISOString().replace(/[:.]/g, '-')}`);
    writeSecret(backup, text, configFile);
    res.backup = backup;
    if (s.hash) {
      const f = isObj(s.out.providers) && isObj(s.out.providers.ffbox) && typeof s.out.providers.ffbox.tokenSha256File === 'string' ? s.out.providers.ffbox.tokenSha256File : path.join(secretsDir, FFBOX_HASH_FILE);
      writeFfboxTokenHash(f, s.hash, configFile);
      const p = s.out.providers as Record<string, unknown>;
      s.out.providers = { ...p, ffbox: { ...(p.ffbox as object), tokenSha256File: f } };
    }
    writeFileDurable(configFile, JSON.stringify(s.out, null, 2) + '\n', { generations: 0, mode });
    fs.chmodSync(configFile, mode);
  }
  res.scrubbed = scrubSavedVersions(configFile, secretsDir);
  res.warnings = credentialPaths(s.out);
  return res;
}

/** Rewrite config.json's saved versions without the w1078 keys; move the ones that cannot be read but may hold a secret aside. */
function scrubSavedVersions(configFile: string, secretsDir: string): string[] {
  const dir = path.dirname(configFile);
  const base = path.basename(configFile);
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.`));
  } catch {
    return out;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (!fs.statSync(file).isFile()) continue;
      const text = fs.readFileSync(file, 'utf8');
      let raw: unknown;
      try {
        raw = parse(text);
      } catch {
        raw = undefined;
      }
      if (isObj(raw)) {
        const s = stripConfig(raw);
        if (!s.changes.length) continue;
        const mode = fs.statSync(file).mode & 0o777;
        writeFileDurable(file, JSON.stringify(s.out, null, 2) + '\n', { generations: 0, mode });
        out.push(name);
        continue;
      }
      if (!/sk-ant-|CLAUDE_CODE_OAUTH_TOKEN|tokenSha256|claudeEnv/.test(text) && redactSecrets(text) === text) continue;
      const aside = path.join(secretsDir, `${name}.before-w1078`);
      writeSecret(aside, text, configFile);
      fs.rmSync(file, { force: true });
      out.push(`${name} (moved to the secrets folder)`);
    } catch {
      // gone meanwhile, or not ours to change: the next start tries again
    }
  }
  return out;
}

/**
 * The config files the owners' orchestrators, the dispatcher and the ops worker may read: config.json and its saved versions
 * (.prev, .1-.3) that exist and hold no secret (inlineSecrets). A file that still holds one stays closed.
 */
export function readableConfigFiles(configFile: string): string[] {
  return [configFile, `${configFile}.prev`, `${configFile}.1`, `${configFile}.2`, `${configFile}.3`].filter((f) => {
    try {
      return inlineSecrets(parse(fs.readFileSync(f, 'utf8'))).length === 0;
    } catch {
      return false;
    }
  });
}

/**
 * The token file of the retired "tokenfile" account (w464; `fffctl claude-token` wrote it) once nothing needs it: config
 * names no claudeTokenFile any more, this release's deploy has verified (data/update.verified.json, or its .done.json once
 * the machines followed, names this commit), and the dispatcher runs on a vault token. Then it is deleted, with no copy
 * (lothsahn, 2026-10-12: "does anything use /srv/fff/secrets/claude-oauth-token or can we delete that file too? if so,
 * let's delete it."). Answers what it did, or why it waits; nothing when there is no such file.
 */
export function retireOldTokenFile(o: { configFile: string; secretsDir: string; dataDir: string; sha: string | undefined; dispatcherOnVault: boolean }): { deleted?: string; waiting?: string } {
  const file = path.join(o.secretsDir, OLD_TOKEN_FILE);
  if (!fs.existsSync(file)) return {};
  try {
    const raw = parse(fs.readFileSync(o.configFile, 'utf8'));
    if (isObj(raw) && raw.claudeTokenFile !== undefined) return { waiting: 'config.json still names claudeTokenFile' };
  } catch {
    return { waiting: 'config.json cannot be read' };
  }
  const verified = ['update.verified.json', 'update.verified.done.json'].some((n) => {
    try {
      const v = parse(fs.readFileSync(path.join(o.dataDir, n), 'utf8'));
      const sha = isObj(v) && typeof v.sha === 'string' ? v.sha : '';
      return !!o.sha && !!sha && (sha.startsWith(o.sha) || o.sha.startsWith(sha));
    } catch {
      return false;
    }
  });
  if (!verified) return { waiting: 'this release has not verified yet' };
  if (!o.dispatcherOnVault) return { waiting: 'the dispatcher does not run on a vault token yet' };
  fs.rmSync(file, { force: true });
  return { deleted: file };
}
