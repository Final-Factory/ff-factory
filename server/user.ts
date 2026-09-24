// Create a user or change a password:  node server/user.ts <username>
// Prompts for the password (or reads FFSB_PASSWORD). Run it on the host; it writes data/users.json.
import readline from 'node:readline';
import { loadConfig } from './config.ts';
import { Auth } from './auth.ts';

const username = process.argv[2];
if (!username) {
  console.error('usage: node server/user.ts <username>');
  process.exit(2);
}
const cfg = loadConfig();
let password = process.env.FFSB_PASSWORD;
if (!password) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  password = await new Promise<string>((r) => rl.question(`Password for ${username} (12+ chars): `, r));
  rl.close();
}
await new Auth(cfg.dataDir, { trustProxy: false }).setUser(username, password);
console.log(`saved ${username}; their existing sessions were signed out`);
