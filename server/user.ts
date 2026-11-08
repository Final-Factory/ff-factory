// Create a login, change its password, or change its profile (docs/identity.md):
//   node server/user.ts <username> [--name "Display Name"] [--role owner|member]
//   node server/user.ts <username> --name "Display Name" --role member --keep-password
//   node server/user.ts <username> --link [--hours 24]
// Prompts for the password (or reads FFSB_PASSWORD); --keep-password changes only the name or role. The first
// login is the owner, later ones members, unless --role says otherwise. Run it on the host; it writes data/users.json.
// --link (w3714) makes a one-time link (<publicUrl>/set-password#t=...) with which the login's person sets their own
// password, so none passes through a chat. It is written to data/password-link-<username>.txt (0600), never printed:
// the output names the file and the token's last 4 characters. A new link replaces the login's earlier one.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { Auth } from './auth.ts';
import type { UserRole } from '../shared/types.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { name: { type: 'string' }, role: { type: 'string' }, 'keep-password': { type: 'boolean' }, link: { type: 'boolean' }, hours: { type: 'string' } },
});
const username = positionals[0];
if (!username || (values.role !== undefined && values.role !== 'owner' && values.role !== 'member')) {
  console.error('usage: node server/user.ts <username> [--name "Display Name"] [--role owner|member] [--keep-password | --link [--hours N]]');
  process.exit(2);
}
const profile = { displayName: values.name, role: values.role as UserRole | undefined };
const cfg = loadConfig();
const auth = new Auth(cfg.dataDir, { trustProxy: false });
if (values.link) {
  const hours = values.hours === undefined ? 24 : Number(values.hours);
  if (!(hours > 0 && hours <= 168)) throw new Error('--hours: more than 0, at most 168');
  const { token, expires } = auth.mintPasswordLink(username, hours * 3600 * 1000);
  const base = (cfg.publicUrl ?? `http://localhost:${cfg.port}`).replace(/\/+$/, '');
  const file = path.join(cfg.dataDir, `password-link-${username}.txt`);
  fs.writeFileSync(file, `${base}/set-password#t=${token}\n`, { mode: 0o600 });
  console.log(`one-time set-password link for ${username} (token …${token.slice(-4)}, until ${new Date(expires).toISOString()}) written to ${file}`);
} else if (values['keep-password']) {
  auth.setProfile(username, profile);
  const u = auth.userInfo(username)!;
  console.log(`saved ${username}: "${u.displayName}", ${u.role}; password and sessions unchanged`);
} else {
  let password = process.env.FFSB_PASSWORD;
  if (!password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    password = await new Promise<string>((r) => rl.question(`Password for ${username} (12+ chars): `, r));
    rl.close();
  }
  await auth.setUser(username, password, profile);
  const u = auth.userInfo(username)!;
  console.log(`saved ${username} ("${u.displayName}", ${u.role}); their existing sessions were signed out`);
}
