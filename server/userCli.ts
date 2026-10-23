// Logins from the command line (w1864): what `fffctl user ...` runs in the VM, as the portal's account. Creating a login or
// changing its password stays `node server/user.ts` (docs/identity.md).
//
//   node server/userCli.ts list                                   every login: id, display name, role (never a hash)
//   node server/userCli.ts delete ID --by LOGIN [--members-only]  delete a login and everything of its own
//
// delete hands the running portal a request (data/login-delete/<id>.json) and prints its answer: the portal holds the
// login's sessions, settings and orchestrator in memory, so it does the delete itself (server/loginDelete.ts). --by is the
// login this is run as or for, never deleted by its own request; --members-only (the orchestration worker's form) refuses
// an owner login. The answer names what went and never a key or a password.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { Auth } from './auth.ts';
import { LOGIN_DELETE_DIR, type LoginDeleteAnswer } from './loginDelete.ts';

const USAGE = 'user list | delete ID --by LOGIN [--members-only]';
const die = (msg: string, code = 2): never => {
  console.error(`user: ${msg}`);
  process.exit(code);
};

let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, strict: true, options: { by: { type: 'string' }, 'members-only': { type: 'boolean' } } });
} catch (e) {
  die(`${(e as Error).message} (${USAGE})`);
}
const { values: o, positionals: args } = parsed!;
const sub = args[0];
const cfg = loadConfig();
const waitSeconds = Number(process.env.FFF_USER_DELETE_WAIT_SEC) || 30;

if (sub === 'list') {
  if (args.length !== 1 || Object.keys(o).length) die('list takes nothing more');
  const all = new Auth(cfg.dataDir, { trustProxy: false }).userInfos();
  console.log(all.length ? all.map((u) => `${u.userId.padEnd(24)} ${u.role.padEnd(7)} ${u.displayName}`).join('\n') : 'no logins');
} else if (sub === 'delete') {
  if (args.length !== 2) die('delete ID --by LOGIN [--members-only]');
  const by = o.by ?? die('--by LOGIN: the login this is run as or for (the person who asked); it is never the one deleted');
  const dir = path.join(cfg.dataDir, LOGIN_DELETE_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ user: args[1], by, ...(o['members-only'] ? { membersOnly: true } : {}) }), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  const result = path.join(dir, `${id}.result.json`);
  const until = Date.now() + waitSeconds * 1000;
  while (!fs.existsSync(result) && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
  if (!fs.existsSync(result)) {
    // Not taken: take the request back so a portal that starts later does not run it unasked.
    const taken = !fs.existsSync(file);
    fs.rmSync(file, { force: true });
    die(taken ? `the portal took the request but gave no answer in ${waitSeconds} s: read fffctl logs ("login deleted" or "login delete:")` : `the portal did not answer in ${waitSeconds} s: it must be running (fffctl status); nothing was deleted`, 1);
  }
  const answer = JSON.parse(fs.readFileSync(result, 'utf8')) as LoginDeleteAnswer;
  fs.rmSync(result, { force: true });
  if (!answer.ok) die(answer.error);
  else console.log(answer.lines.join('\n'));
} else die(USAGE);
