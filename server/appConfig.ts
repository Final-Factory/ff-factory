import fs from 'node:fs';
import { VOICE_DEFAULTS, type Config } from './config.ts';

/**
 * The config.json keys an agent may change (the set_app_config tool). Only cosmetic ones: nothing that
 * touches paths, limits, permissions, models, the guard or the network. Each applies to the running
 * server at once (the config object is shared) and is written to config.json for the next start.
 */
export const SETTABLE_KEYS = ['ownerName', 'voice.vocabulary', 'voice.ttsVoice'] as const;
export type SettableKey = (typeof SETTABLE_KEYS)[number];

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The value to store for `key`, or throws with what is wrong. `null` removes the key (back to the default). */
export function normalizeSetting(key: SettableKey, value: unknown): string | string[] | undefined {
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
  const v = normalizeSetting(key, value);
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
  return { before, after: v };
}
