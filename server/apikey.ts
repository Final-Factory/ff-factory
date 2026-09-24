// Mint or revoke an API key for a machine client (e.g. Claude Code's MCP connection to /mcp).
//   node server/apikey.ts <name>            print a new key (shown once; replaces <name>'s old key)
//   node server/apikey.ts --revoke <name>
import { loadConfig } from './config.ts';
import { Auth } from './auth.ts';

const cfg = loadConfig();
const auth = new Auth(cfg.dataDir, { trustProxy: false });
const [a, b] = process.argv.slice(2);
if (a === '--revoke' && b) {
  console.log(auth.revokeApiKey(b) ? `revoked ${b}` : `no key named ${b}`);
} else if (a && !a.startsWith('-')) {
  console.log(auth.createApiKey(a));
} else {
  console.error('usage: node server/apikey.ts <name> | --revoke <name>');
  process.exit(2);
}
