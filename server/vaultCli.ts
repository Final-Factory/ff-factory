// The token vault from the command line (docs/vault.md, w512): what `sudo fffctl vault …` and `fffctl machine-credential …`
// run in the VM. A value is read from a file or stdin, never from the command line, and never printed: every answer is an
// entry's name, kind, grants, fingerprint and last four characters.
//
//   node server/vaultCli.ts list
//   node server/vaultCli.ts add --name NAME --kind claude|github|env [--env VAR] [--owner USER] [--share owner|anyone]
//                               [--roles workers,standing] [--machines m3,m5|*] (--file FILE | --stdin)
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
import { VAULT_FILE, Vault, keySource, newKeyText, type VaultEntryMeta, type VaultKind, type VaultRole, type VaultShare } from './vault.ts';

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

/** Give `file` to the owner of `like` when root wrote it (the portal runs as its own user). */
function chownLike(file: string, like: string) {
  if (!isRoot()) return;
  const st = fs.statSync(like);
  fs.chownSync(file, st.uid, st.gid);
}

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
  const tokens = machineTokensFile(cfg.dataDir);
  if (sub === 'list') {
    const ids = enrolledMachines(cfg.dataDir);
    console.log(ids.length ? ids.join('\n') : 'no machine holds a credential');
  } else if (sub === 'issue') {
    const id = args[2] ?? die('machine-credential issue ID --out FILE');
    const out = o.out ?? die('--out FILE: where the credential goes (0600); it is never printed');
    if (fs.existsSync(out)) die(`${out} exists; pick a new file`);
    const token = issueMachineToken(cfg.dataDir, id);
    chownLike(tokens, cfg.dataDir);
    fs.writeFileSync(out, `${token}\n`, { mode: 0o600 });
    fs.chmodSync(out, 0o600);
    console.log(`a new credential for ${id} is in ${out} (0600), ending …${token.slice(-4)}; the one before no longer connects. Move it to the machine, then delete ${out}.`);
  } else if (sub === 'revoke') {
    const id = args[2] ?? die('machine-credential revoke ID');
    if (!revokeMachineToken(cfg.dataDir, id)) die(`machine ${id} holds no credential`);
    chownLike(tokens, cfg.dataDir);
    console.log(`revoked ${id}'s credential: the portal drops its link within 20 s; its record and sandboxes stay. A new one: machine-credential issue ${id} --out FILE`);
  } else die('machine-credential list | issue ID --out FILE | revoke ID');
  process.exit(0);
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
      const s = vault.status();
      console.log(`key: ${s.key}${s.keyFile ? ` (${s.keyFile})` : ''}${s.why ? `: ${s.why}` : ''}`);
      const all = vault.list();
      console.log(all.length ? all.map(show).join('\n') : 'no entries');
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
