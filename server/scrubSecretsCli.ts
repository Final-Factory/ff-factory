// Redact secrets already on disk (w1584): what `sudo fffctl scrub-secrets` runs in the portal VM, and what a worker machine
// runs over its Claude Code projects folder. It masks every token shape and every value the vault holds, the way the stores
// mask them as they write (server/scrubSecrets.ts), and prints file paths and counts, never a value.
//
//   node server/scrubSecretsCli.ts [--dry-run] [--no-data] [--claude-projects DIR]... [PATH]...
//
//   (no option)            the portal's data folder (config.json's dataDir, $FFSB_CONFIG): transcripts, the saved
//                          generations of state.json and work.json, logs. The live state.json and work.json are only
//                          counted: the portal rewrites them from memory, and redacts them itself at its next start.
//   --dry-run              count only, write nothing
//   --no-data              not the data folder (a worker machine with no portal config)
//   --claude-projects DIR  also Claude Code's own transcripts and tool-result files (<home>/.claude/projects)
//   PATH                   also these files or folders
//
// A file changed in the last two minutes is being written (a live transcript): counted, left, and named; run again.
//
// Vault values are masked when the vault key opens (FFF_VAULT_KEY_FILE, which fffctl sets, else the portal's key source);
// token shapes always. The last line says what is left: "remaining: 0" when nothing is. Exit 0 then, 1 when any remain or a
// file could not be scrubbed, 2 on a usage error.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { registerSecretValues } from './secrets.ts';
import { reportLines, scrubTree } from './scrubSecrets.ts';
import { VAULT_FILE, Vault, keySource } from './vault.ts';

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean' }, 'no-data': { type: 'boolean' }, 'claude-projects': { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' } },
  });
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const o = parsed.values;
if (o.help) {
  console.log('node server/scrubSecretsCli.ts [--dry-run] [--no-data] [--claude-projects DIR]... [PATH]...   (sudo fffctl scrub-secrets [--dry-run] in the VM)');
  process.exit(0);
}
const dryRun = !!o['dry-run'];
const roots: string[] = [...(o['claude-projects'] ?? []), ...parsed.positionals].map((p) => path.resolve(p));
const live: string[] = [];

if (!o['no-data']) {
  const cfg = loadConfig();
  roots.unshift(cfg.dataDir);
  live.push(path.join(cfg.dataDir, 'state.json'), path.join(cfg.dataDir, 'work.json'));
  let known = 0;
  const keyFile = process.env.FFF_VAULT_KEY_FILE;
  try {
    new Vault({
      file: path.join(cfg.dataDir, VAULT_FILE),
      key: () => (keyFile ? { file: keyFile } : keySource(cfg)),
      onValues: (values) => {
        known = values.length;
        registerSecretValues(values);
      },
    });
  } catch (e) {
    console.log(`vault: not opened (${(e as Error).name}): token shapes only`);
  }
  console.log(known ? `vault: ${known} value(s) known, masked wherever they appear` : 'vault: no value opened (no key or no entries): token shapes only');
}
if (!roots.length) {
  console.error('nothing to scrub: give --claude-projects DIR or a PATH with --no-data');
  process.exit(2);
}

// The portal's live state files are counted, never rewritten under it; nor is a file changed in the last two minutes (a
// transcript being written: the portal or Claude Code appends to it; run again later).
const BUSY_MS = 2 * 60_000;
const first = scrubTree(roots, { dryRun: true });
const liveHeld = first.files.filter((f) => live.includes(f.file));
const busyHeld = first.files.filter((f) => !live.includes(f.file) && Date.now() - fs.statSync(f.file).mtimeMs < BUSY_MS);
let report = first;
if (!dryRun) {
  const writable = first.files.filter((f) => !liveHeld.includes(f) && !busyHeld.includes(f)).map((f) => f.file);
  const written = scrubTree(writable);
  report = { ...written, scanned: first.scanned, skipped: first.skipped, errors: [...first.errors, ...written.errors] };
}
const after = dryRun ? first : scrubTree(roots, { dryRun: true });
for (const line of reportLines(report, { dryRun })) console.log(line);
if (!dryRun) {
  for (const f of liveHeld) console.log(`${f.file}: ${f.count} left: the portal rewrites this file from memory and redacts it at its next start`);
  for (const f of busyHeld) console.log(`${f.file}: ${f.count} left: changed in the last two minutes (being written); run again`);
}
console.log(`remaining: ${after.total}`);
process.exit(after.total || report.errors.length ? 1 : 0);
