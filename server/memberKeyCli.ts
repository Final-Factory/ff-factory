// API keys for member logins from the command line (w1415): what `fffctl apikey ...` runs in the VM, as the portal's account
// (so users.json and api-keys.json stay the portal's). The key goes to --out (0600) and is never printed: only its last four
// characters. Rules and refusals: server/memberKeys.ts.
//
//   node server/memberKeyCli.ts list
//   node server/memberKeyCli.ts issue NAME --user ID [--create-member [--display-name TEXT]] --out FILE
//   node server/memberKeyCli.ts revoke NAME
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { Auth } from './auth.ts';
import { MemberKeyRefused, issueMemberKey, memberKeys, revokeMemberKey } from './memberKeys.ts';

const USAGE = 'apikey list | issue NAME --user ID [--create-member [--display-name TEXT]] --out FILE | revoke NAME';
const die = (msg: string): never => {
  console.error(`apikey: ${msg}`);
  process.exit(2);
};

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    strict: true,
    options: { user: { type: 'string' }, 'create-member': { type: 'boolean' }, 'display-name': { type: 'string' }, out: { type: 'string' } },
  });
} catch (e) {
  die(`${(e as Error).message} (${USAGE})`);
}
const { values: o, positionals: args } = parsed!;
const sub = args[0];
const auth = new Auth(loadConfig().dataDir, { trustProxy: false });

try {
  if (sub === 'list') {
    if (args.length !== 1 || Object.keys(o).length) die('list takes nothing more');
    const keys = memberKeys(auth);
    console.log(keys.length ? keys.map((k) => `${k.name.padEnd(24)} ${String(k.user).padEnd(24)} ${k.createdAt}`).join('\n') : 'no key acts for a member login');
  } else if (sub === 'issue') {
    if (args.length !== 2) die(`issue NAME --user ID [--create-member [--display-name TEXT]] --out FILE`);
    const r = await issueMemberKey(auth, {
      name: args[1],
      user: o.user ?? die('--user ID: the member login the key acts for'),
      createMember: o['create-member'],
      ...(o['display-name'] !== undefined ? { displayName: o['display-name'] } : {}),
      out: o.out ?? die('--out FILE: where the key goes (0600); it is never printed'),
    });
    console.log(
      `${r.createdLogin ? `made the member login ${o.user} (a random password nobody sees); ` : ''}a ${r.replaced ? 'new key replaced' : 'key'} ${args[1]} for ${o.user}, ending …${r.last4}, in ${o.out} (0600)`,
    );
  } else if (sub === 'revoke') {
    if (args.length !== 2 || Object.keys(o).length) die('revoke NAME');
    const user = revokeMemberKey(auth, args[1]);
    console.log(`revoked ${args[1]} (it acted for ${user}); the login stays`);
  } else die(USAGE);
} catch (e) {
  if (e instanceof MemberKeyRefused) die(e.message);
  throw e;
}
