// The token vault from the command line (docs/vault.md, w512): what `sudo fffctl vault …` and `fffctl machine-credential …`
// run in the VM. A value is read from a file or stdin, never from the command line, and never printed: every answer is an
// entry's name, kind, grants, fingerprint and last four characters.
//
//   node server/vaultCli.ts list
//   node server/vaultCli.ts add --name NAME --kind claude|github|env [--env VAR] [--owner USER] [--share owner|anyone]
//                               [--roles workers,standing] [--machines m3,m5|*] (--file FILE | --stdin)
//   node server/vaultCli.ts put --name NAME --kind ... [the add options] (--file FILE | --stdin)
//                               add, or bring an entry to this value and these grants (the FFBox host's fff-vm vault-sync)
//   node server/vaultCli.ts list --names                  the entries' names only, one per line
//   node server/vaultCli.ts rotate NAME (--file FILE | --stdin)
//   node server/vaultCli.ts grant NAME [--owner USER] [--share owner|anyone] [--roles …] [--machines …] [--enable | --disable]
//   node server/vaultCli.ts remove NAME
//   node server/vaultCli.ts new-key FILE [--force]        a new key file (0600); --force replaces one (entries then need rotating)
//   node server/vaultCli.ts machine-credential list
//   node server/vaultCli.ts machine-credential issue ID --out FILE    a fresh credential for a machine, written to FILE (0600)
//   node server/vaultCli.ts machine-credential revoke ID
//
// The key: $FFF_VAULT_KEY_FILE (fffctl sets /etc/fff/vault.key), else what the portal uses (keySource). Run as root, the
// files it writes are given to the data folder's owner, so the portal can read them.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { enrolledMachines, issueMachineToken, machineTokensFile, revokeMachineToken } from './machineTokens.ts';
import type { PlanUsage } from '../shared/types.ts';
import { clock, poolLimits } from './tokenPool.ts';
import { VAULT_FILE, Vault, fingerprintOf, keySource, newKeyText, type VaultEntryMeta, type VaultKind, type VaultRole, type VaultShare } from './vault.ts';

const { values: o, positionals: args } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    kind: { type: 'string' },
    env: { type: 'string' },
    owner: { type: 'string' },
    share: { type: 'string' },
    roles: { type: 'string' },
    machines: { type: 'string' },
    file: { type: 'string' },
    stdin: { type: 'boolean' },
    out: { type: 'string' },
    names: { type: 'boolean' },
    force: { type: 'boolean' },
    enable: { type: 'boolean' },
    disable: { type: 'boolean' },
  },
});

const die = (msg: string): never => {
  console.error(`vault: ${msg}`);
  process.exit(2);
};
const list = (v: string | undefined) => v?.split(',').map((x) => x.trim()).filter(Boolean);
const isRoot = () => process.getuid?.() === 0;

/** The value, from --file or stdin: one line, never echoed. */
function readValue(): string {
  if (o.file && o.stdin) die('give --file or --stdin, not both');
  let text: string;
  if (o.file) {
    try {
      text = fs.readFileSync(o.file, 'utf8');
    } catch (e) {
      return die(`cannot read ${o.file}: ${(e as NodeJS.ErrnoException).code ?? 'unreadable'}`);
    }
  } else if (o.stdin) text = fs.readFileSync(0, 'utf8');
  else return die('the value comes from --file FILE or --stdin, never the command line');
  const value = text.replace(/^﻿/, '').trim();
  if (value.includes('\n')) die('the file holds more than one line; put the value alone in it');
  return value;
}

const show = (e: VaultEntryMeta) =>
  `${e.name.padEnd(20)} ${e.kind.padEnd(6)} ${(e.env ?? '').padEnd(20)} …${e.last4}  ${e.fingerprint}  ${e.share === 'owner' ? `owner ${e.owner}` : `anyone${e.owner ? ` (owner ${e.owner})` : ''}`}; ${e.roles.join(',')} on ${e.machines.join(',')}${e.disabled ? ' (DISABLED)' : ''}`;

const cfg = loadConfig();
const cmd = args[0];

if (cmd === 'new-key') {
  const file = args[1] ?? die('new-key FILE');
  if (fs.existsSync(file) && !o.force) die(`${file} exists; --force replaces it (every entry then needs rotating)`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, newKeyText(), { mode: 0o600 });
  fs.chmodSync(`${file}.tmp`, 0o600);
  fs.renameSync(`${file}.tmp`, file);
  console.log(`a new vault key in ${file} (0600; its content is not shown)`);
  process.exit(0);
}

if (cmd === 'machine-credential') {
  const sub = args[1];
  if (sub === 'list') {
    const ids = enrolledMachines(cfg.dataDir);
    console.log(ids.length ? ids.join('\n') : 'no machine holds a credential');
  } else if (sub === 'issue') {
    const id = args[2] ?? die('machine-credential issue ID --out FILE');
    const out = o.out ?? die('--out FILE: where the credential goes (0600); it is never printed');
    if (fs.existsSync(out)) die(`${out} exists; pick a new file`);
    const token = issueMachineToken(cfg.dataDir, id, cfg.dataDir);
    fs.writeFileSync(out, `${token}\n`, { mode: 0o600 });
    fs.chmodSync(out, 0o600);
    console.log(`a new credential for ${id} is in ${out} (0600), ending …${token.slice(-4)}; a daemon still on the one before is dropped within 20 s. Move it to the machine, then delete ${out}.`);
  } else if (sub === 'revoke') {
    const id = args[2] ?? die('machine-credential revoke ID');
    if (!revokeMachineToken(cfg.dataDir, id, cfg.dataDir)) die(`machine ${id} holds no credential`);
    console.log(`revoked ${id}'s credential: the portal drops its link within 20 s; its record and sandboxes stay. A new one: machine-credential issue ${id} --out FILE`);
  } else die('machine-credential list | issue ID --out FILE | revoke ID');
  process.exit(0);
}

/**
 * Each person's Claude pool as the portal's rules read it (w739, docs/vault.md section 4): per token its last four
 * characters, the plan meters the portal last polled (data/usage.json) with their resets, the state (ok, held,
 * one-at-a-time, retired, exhausted) and how many agents ran on it when the portal last saved its state (state.json). Read
 * only, no token and no key needed. The portal's own system_status is the live view.
 */
function poolSection() {
  let usageFile: { entries?: Record<string, { usage?: PlanUsage }> } = {};
  try {
    usageFile = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'usage.json'), 'utf8')) as typeof usageFile;
  } catch {
    // the portal has not polled yet
  }
  let sessions: { account?: string; status?: string }[] = [];
  try {
    sessions = (JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'state.json'), 'utf8')) as { sessions?: typeof sessions }).sessions ?? [];
  } catch {
    // no state file
  }
  const live = (fp: string) => sessions.filter((x) => x.account === `token:${fp}` && x.status !== 'stopped' && x.status !== 'error').length;
  const pools = vault.pools({ usageOf: (fp) => usageFile.entries?.[`token:${fp}`]?.usage, liveOn: (fp) => live(fp), limits: () => poolLimits(cfg) });
  // A Claude entry with no owner is in nobody's pool: the portal no longer hands out a shared Claude token (w739).
  const orphans = vault.list().filter((e) => e.kind === 'claude' && !e.disabled && !e.owner);
  if (orphans.length) console.log(`
not in any pool (a Claude token with no owner is used by nobody; grant it to a person with --owner): ${orphans.map((e) => `${e.name} …${e.last4}`).join(', ')}`);
  if (!pools.size) return;
  const lim = poolLimits(cfg);
  console.log(`
Claude token pools (5-hour >= ${lim.sessionHold}%: held; weekly >= ${lim.onePerWeekly}%: one at a time; >= ${lim.retireWeekly}%: retired; soonest weekly reset first):`);
  for (const [person, list] of [...pools].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${person}`);
    for (const t of list.sort((a, b) => (a.view.weeklyResetsAt ?? '9').localeCompare(b.view.weeklyResetsAt ?? '9'))) {
      const v = t.view;
      console.log(`    ${t.entry.name.padEnd(24)} …${t.entry.last4}  ${v.state.padEnd(13)} 5-hour ${v.known ? Math.round(v.session) + '%' : '?'}${v.sessionResetsAt ? ` (resets ${clock(v.sessionResetsAt)})` : ''}, weekly ${v.known ? Math.round(v.weekly) + '%' : '?'}${v.weeklyResetsAt ? ` (resets ${clock(v.weeklyResetsAt)})` : ''}; ${t.live} agent${t.live === 1 ? '' : 's'} running${v.state === 'ok' && !v.why.includes('one job') ? '' : `
${' '.repeat(8)}${v.why}`}`);
    }
  }
}

const keyFile = process.env.FFF_VAULT_KEY_FILE;
const vault = new Vault({
  file: path.join(cfg.dataDir, VAULT_FILE),
  key: () => (keyFile ? { file: keyFile } : keySource(cfg)),
  ...(isRoot() ? { chownLike: cfg.dataDir } : {}),
});

try {
  switch (cmd) {
    case undefined:
    case 'list': {
      if (o.names) {
        for (const e of vault.list()) console.log(e.name);
        break;
      }
      const s = vault.status();
      console.log(`key: ${s.key}${s.keyFile ? ` (${s.keyFile})` : ''}${s.why ? `: ${s.why}` : ''}`);
      const all = vault.list();
      console.log(all.length ? all.map(show).join('\n') : 'no entries');
      poolSection();
      break;
    }
    case 'add': {
      const e = vault.add({
        name: o.name ?? die('--name NAME'),
        kind: (o.kind ?? die('--kind claude|github|env')) as VaultKind,
        value: readValue(),
        env: o.env,
        owner: o.owner,
        share: o.share as VaultShare | undefined,
        roles: list(o.roles) as VaultRole[] | undefined,
        machines: list(o.machines),
      });
      console.log(`added: ${show(e)}${o.file ? `\nDelete ${o.file} now (shred -u).` : ''}`);
      break;
    }
    case 'put': {
      // Idempotent: the same value and grants change nothing; a new value rotates; other grants are set.
      const name = o.name ?? die('--name NAME');
      const kind = (o.kind ?? die('--kind claude|github|env')) as VaultKind;
      const value = readValue();
      const grants = {
        ...(o.owner !== undefined ? { owner: o.owner } : {}),
        share: (o.share ?? 'owner') as VaultShare,
        roles: (list(o.roles) ?? ['workers', 'standing']) as VaultRole[],
        machines: list(o.machines) ?? ['*'],
      };
      const was = vault.list().find((e) => e.name === name);
      if (!was) {
        const e = vault.add({ name, kind, value, env: o.env, ...grants });
        console.log(`added: ${show(e)}`);
        break;
      }
      if (was.kind !== kind || (was.env ?? undefined) !== (o.env ?? undefined)) die(`${name} is kind ${was.kind}${was.env ? ` (${was.env})` : ''}; remove it first to change its kind`);
      const rotated = was.fingerprint !== fingerprintOf(value);
      if (rotated) vault.rotate(name, value);
      const same = (a: string[], b: string[]) => a.join() === b.join();
      const regrant = (grants.owner ?? '') !== (was.owner ?? '') || grants.share !== was.share || !same(grants.roles, was.roles) || !same(grants.machines.map((m) => m.toLowerCase()), was.machines) || was.disabled;
      const e = regrant ? vault.update(name, { ...grants, owner: grants.owner ?? '', disabled: false }) : vault.list().find((x) => x.name === name)!;
      console.log(`${rotated ? 'rotated' : regrant ? 'regranted' : 'unchanged'}: ${show(e)}`);
      break;
    }
    case 'rotate': {
      const e = vault.rotate(args[1] ?? die('rotate NAME'), readValue());
      console.log(`rotated: ${show(e)}; runs started from now get it${o.file ? `\nDelete ${o.file} now (shred -u).` : ''}`);
      break;
    }
    case 'grant': {
      if (o.enable && o.disable) die('--enable or --disable, not both');
      const e = vault.update(args[1] ?? die('grant NAME'), {
        ...(o.owner !== undefined ? { owner: o.owner } : {}),
        ...(o.share !== undefined ? { share: o.share as VaultShare } : {}),
        ...(o.roles !== undefined ? { roles: (list(o.roles) ?? []) as VaultRole[] } : {}),
        ...(o.machines !== undefined ? { machines: list(o.machines) ?? [] } : {}),
        ...(o.enable ? { disabled: false } : o.disable ? { disabled: true } : {}),
      });
      console.log(`changed: ${show(e)}`);
      break;
    }
    case 'remove': {
      const e = vault.remove(args[1] ?? die('remove NAME'));
      console.log(`removed ${e.name} (…${e.last4}). Revoke the token itself where it was made, too.`);
      break;
    }
    default:
      die(`unknown command ${cmd} (list, add, rotate, grant, remove, new-key, machine-credential)`);
  }
} catch (e) {
  die((e as Error).message);
}
