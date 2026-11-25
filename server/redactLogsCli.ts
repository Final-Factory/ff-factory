// Redact log lines on their way out (w5525, security audit w5452 finding 16): what `fffctl logs` pipes the portal's journal
// through (deploy/vm/guest/fff-ops-priv), so the orchestration worker reads it the way portal_logs shows it. It masks when it
// reads, so journal entries written before the portal redacted its own output come out masked too.
//
//   journalctl -u fff-portal.service ... | node server/redactLogsCli.ts
//
// Each line of stdin is written to stdout through lineRedactor (server/logRedact.ts): a private key's lines, BEGIN to END,
// withheld; every other line through redactLogLines: the vault's values, every token shape of the shared set
// (shared/secretShapes.ts) and the log forms (headers, cookies, query strings, assignments); a line that still looks like a
// secret is withheld. With FFSB_CONFIG set, the vault's values are loaded first (FFF_VAULT_KEY_FILE, which
// fff-ops-priv sets, else the portal's key source), as `fffctl scrub-secrets` loads them; without them, token shapes and log
// forms only, said once on stderr. Never prints a value.
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig } from './config.ts';
import { lineRedactor } from './logRedact.ts';
import { registerSecretValues } from './secrets.ts';
import { VAULT_FILE, Vault, keySource } from './vault.ts';

function loadVaultValues(): string | undefined {
  if (!process.env.FFSB_CONFIG) return 'no FFSB_CONFIG';
  try {
    const cfg = loadConfig();
    const keyFile = process.env.FFF_VAULT_KEY_FILE;
    let known = 0;
    new Vault({
      file: path.join(cfg.dataDir, VAULT_FILE),
      key: () => (keyFile ? { file: keyFile } : keySource(cfg)),
      onValues: (values) => {
        known = values.length;
        registerSecretValues(values);
      },
    });
    return known ? undefined : 'no vault value opened';
  } catch (e) {
    return `the vault did not open (${(e as Error).name})`;
  }
}

const why = loadVaultValues();
if (why) process.stderr.write(`redact-logs: ${why}: token shapes and log forms only\n`);

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const redact = lineRedactor();
rl.on('line', (line) => {
  process.stdout.write(`${redact(line)}\n`);
});
// `fffctl logs | head` closes the pipe early: stop quietly.
process.stdout.on('error', (e: NodeJS.ErrnoException) => process.exit(e.code === 'EPIPE' ? 0 : 1));
