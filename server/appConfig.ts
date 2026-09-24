import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, VOICE_DEFAULTS, type Config } from './config.ts';

/**
 * The config.json keys an agent may change (the set_app_config tool). Only cosmetic ones, plus the public
 * commit identity (which names the identity to use; noreply addresses are always accepted): nothing that
 * touches paths, limits, permissions, models or the network. Each applies to the running server at once
 * (the config object is shared; guards read it when a session starts) and is written to config.json.
 */
export const SETTABLE_KEYS = [
  'ownerName',
  'voice.vocabulary',
  'voice.ttsVoice',
  'publicGitIdentity.name',
  'publicGitIdentity.email',
  // The host guard's housekeeping (docs/self-recovery.md), so it can be tuned without anyone at the desk.
  'hostGuard.devDriveVhdx',
  'hostGuard.compactWhenReclaimGB',
  'hostGuard.cleanup.ageRules',
] as const;
export type SettableKey = (typeof SETTABLE_KEYS)[number];

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

// Windows paths ("C:/x", "\\\\server\\x") are judged as Windows paths on any OS (CI runs on Linux too).
const P = (p: string) => (/^[a-zA-Z]:[\\/]|^\\\\/.test(p) ? path.win32 : path);
const normPath = (p: string) => P(p).resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const inside = (p: string, root: string) => normPath(p) === normPath(root) || normPath(p).startsWith(normPath(root) + '/');

/**
 * Age rules delete old entries in a folder, so the folder must be a specific one: absolute, not a drive root
 * or the home folder itself, and not overlapping this app, its data, the sandboxes, the game's base clone or
 * any protected path.
 */
export function checkAgeRules(value: unknown, cfg?: Pick<Config, 'protectedPaths' | 'sandboxRoot' | 'standingRoot' | 'dataDir' | 'repo'>): { path: string; olderThanDays: number }[] {
  const list = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(list) || list.length > 20) throw new Error('hostGuard.cleanup.ageRules is a list (at most 20) of { "path": "C:/abs/folder", "olderThanDays": 14 }');
  const off = cfg ? [...cfg.protectedPaths, cfg.sandboxRoot, cfg.standingRoot, cfg.dataDir, cfg.repo.basePath, ROOT] : [ROOT];
  return list.map((r) => {
    const p = typeof r?.path === 'string' ? r.path.trim() : '';
    const days = Number(r?.olderThanDays);
    if (!P(p).isAbsolute(p)) throw new Error(`age rule path "${p}" must be absolute`);
    if (normPath(p) === normPath(P(p).parse(P(p).resolve(p)).root) || normPath(p) === normPath(os.homedir())) throw new Error(`age rule path "${p}" is too broad`);
    const clash = off.find((o) => o && (inside(p, o) || inside(o, p)));
    if (clash) throw new Error(`age rule path "${p}" overlaps ${clash}, which clean-up never touches`);
    if (!Number.isFinite(days) || days < 3) throw new Error(`age rule for "${p}": olderThanDays must be at least 3`);
    return { path: p, olderThanDays: Math.round(days) };
  });
}

/** The value to store for `key`, or throws with what is wrong. `null` removes the key (back to the default). */
export function normalizeSetting(key: SettableKey, value: unknown, cfg?: Config): unknown {
  if (value === null || value === undefined) return undefined;
  switch (key) {
    case 'ownerName': {
      if (typeof value !== 'string') throw new Error('ownerName is a string');
      const v = oneLine(value);
      if (!v || v.length > 60 || /[<>`{}$\\]/.test(v)) throw new Error('ownerName: 1-60 characters, one line, no <>`{}$\\');
      return v;
    }
    case 'voice.vocabulary': {
      const list = typeof value === 'string' ? value.split(',') : value;
      if (!Array.isArray(list) || list.some((w) => typeof w !== 'string')) throw new Error('voice.vocabulary is a list of words (or one comma-separated string)');
      const words = [...new Set(list.map((w) => oneLine(w as string)).filter(Boolean))];
      if (words.length > 60 || words.some((w) => w.length > 40)) throw new Error('voice.vocabulary: at most 60 words of up to 40 characters');
      return words;
    }
    case 'publicGitIdentity.name': {
      if (typeof value !== 'string') throw new Error('publicGitIdentity.name is a string');
      const v = oneLine(value);
      if (!v || v.length > 60 || /[<>`{}$\\"]/.test(v)) throw new Error('publicGitIdentity.name: 1-60 characters, one line, no <>`{}$\\"');
      return v;
    }
    case 'publicGitIdentity.email': {
      if (typeof value !== 'string' || !/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(value.trim())) throw new Error('publicGitIdentity.email is an email address, e.g. 12345+you@users.noreply.github.com');
      return value.trim();
    }
    case 'hostGuard.devDriveVhdx': {
      if (typeof value !== 'string' || !P(value.trim()).isAbsolute(value.trim()) || !/\.vhdx?$/i.test(value.trim())) throw new Error('hostGuard.devDriveVhdx is the absolute path of a .vhdx file');
      return value.trim();
    }
    case 'hostGuard.compactWhenReclaimGB': {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 2000) throw new Error('hostGuard.compactWhenReclaimGB is a number of GB from 0 (never) to 2000');
      return Math.round(n);
    }
    case 'hostGuard.cleanup.ageRules':
      return checkAgeRules(value, cfg);
    case 'voice.ttsVoice': {
      if (typeof value !== 'string' || !/^[a-z]{2}_[a-z]+$/.test(value.trim())) throw new Error('voice.ttsVoice is a Kokoro voice name such as "af_heart" or "bm_george"');
      return value.trim();
    }
  }
}

/** Set (or with `undefined`, remove) a dotted key in a plain object. */
function setPath(obj: Record<string, unknown>, key: string, value: unknown) {
  const parts = key.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof o[p] !== 'object' || o[p] === null || Array.isArray(o[p])) o[p] = {};
    o = o[p] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (value === undefined) delete o[last];
  else o[last] = value;
}

function getPath(obj: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), obj);
}

/**
 * Change one allowlisted key in the config file (kept as config.json.prev first; written through a temp
 * file) and in the running config. Returns the value before and after.
 */
export function setAppConfig(file: string, cfg: Config, key: SettableKey, value: unknown): { before: unknown; after: unknown } {
  if (!SETTABLE_KEYS.includes(key)) throw new Error(`${key} cannot be changed by an agent; allowed: ${SETTABLE_KEYS.join(', ')}`);
  const v = normalizeSetting(key, value, cfg);
  const text = fs.readFileSync(file, 'utf8');
  const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as Record<string, unknown>;
  const before = getPath(raw, key);
  setPath(raw, key, v);
  fs.writeFileSync(file + '.prev', text);
  fs.writeFileSync(file + '.tmp', JSON.stringify(raw, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
  // Live: the running server reads these through the shared config object.
  if (key === 'ownerName') cfg.ownerName = v as string | undefined;
  else if (key === 'voice.vocabulary') cfg.voice.vocabulary = (v as string[] | undefined) ?? [];
  else if (key === 'voice.ttsVoice') cfg.voice.ttsVoice = (v as string | undefined) ?? VOICE_DEFAULTS.ttsVoice;
  else if (key === 'hostGuard.devDriveVhdx') cfg.hostGuard.devDriveVhdx = (v as string | undefined) ?? '';
  else if (key === 'hostGuard.compactWhenReclaimGB') cfg.hostGuard.compactWhenReclaimGB = (v as number | undefined) ?? 0;
  else if (key === 'hostGuard.cleanup.ageRules') cfg.hostGuard.cleanup.ageRules = (v as { path: string; olderThanDays: number }[] | undefined) ?? [];
  else if (key === 'publicGitIdentity.name' || key === 'publicGitIdentity.email') {
    const field = key === 'publicGitIdentity.name' ? 'name' : 'email';
    cfg.publicGitIdentity = { ...cfg.publicGitIdentity, [field]: v as string | undefined };
  }
  return { before, after: v };
}
