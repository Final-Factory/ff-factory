// Mint or revoke an API key for a machine client (e.g. Claude Code's MCP connection to /mcp).
//   node server/apikey.ts <name> [--user <login>]   print a new key (shown once; replaces <name>'s old key)
//   node server/apikey.ts --revoke <name>
// --user binds the key to a login: work it starts is requested by that person (docs/identity.md). A key
// without one acts for the owner.
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { Auth } from './auth.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { revoke: { type: 'string' }, user: { type: 'string' } } });
const cfg = loadConfig();
const auth = new Auth(cfg.dataDir, { trustProxy: false });
if (values.revoke) {
  console.log(auth.revokeApiKey(values.revoke) ? `revoked ${values.revoke}` : `no key named ${values.revoke}`);
} else if (positionals[0]) {
  console.log(auth.createApiKey(positionals[0], values.user));
} else {
  console.error('usage: node server/apikey.ts <name> [--user <login>] | --revoke <name>');
  process.exit(2);
}
