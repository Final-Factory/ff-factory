import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { holdersScript, parseHolders, type Holder } from './agentNodeHolders.ts';

/**
 * The agents' node on a Windows worker root (w1742; lothsahn, 2026-10-22: "we're making random folders under the temp
 * directory and nodejs is triggering the windows firewall. Can we fix that so we dont need to directories or
 * something?"). FF Factory's own tests need node 23.6+ (package.json engines) and a machine's node may be older
 * (lothdesktop: 22.17), so workers unpacked a portable node into their session temp folder, a new program path every
 * session; Windows Firewall asks once per path that listens beyond loopback, and those prompts covered unattended
 * machines (rules left on lothdesktop for three V:\ffw\tmp\ffa-*\ node.exe paths, 2026-10-12..20).
 *
 * This keeps one node at a fixed path in the root, `<root>\tools\node\node.exe`: `worker.ts tools` (the rollout after
 * every verified deploy) puts the pinned version there, the daemon puts its folder first on its agents' PATH
 * (machine/daemon.ts slotEnv), and the install's elevated firewall step gives that one path its rule
 * (scripts/worker/firewall.ps1 -AgentNode). An upgrade replaces the folder's contents, never its path, so the rule
 * keeps fitting. Windows only: a Mac or Linux worker has no such prompt.
 */

/**
 * The pinned build: nodejs.org's SHASUMS256.txt for v24.22.1 (fetched and checked 2026-10-22, w1742). `exeSha256` is the
 * node.exe inside that zip and `treeSha256` the digest of all its files (`treeDigest`), both from the zip unpacked with
 * Windows' tar.exe (w5839, 2026-11-25: 1994 files; BEAST's tools\node gave the same two digests).
 */
export const AGENT_NODE = {
  version: 'v24.22.1',
  zip: 'node-v24.22.1-win-x64.zip',
  sha256: 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
  exeSha256: 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5',
  treeSha256: '3983141a10f864dbf120545a5bb459883bfff0ce450d8831cb0a1e8caddafa7b',
} as const;

/** The firewall group of the node's rule (scripts/worker/firewall.ps1 $NodeGroup). */
export const NODE_GROUP = 'Final Factory agent node';

export const agentNodeDir =(root: string) => path.join(root, 'tools', 'node');
export const agentNodeExe = (root: string) => path.join(agentNodeDir(root), 'node.exe');

type Ran = { code: number | null; stdout: string; stderr: string };
export interface AgentNodeDeps {
  exec: (cmd: string, args: string[], o?: { cwd?: string; timeoutMs?: number }) => Promise<Ran>;
  say: (line: string) => void;
  platform: NodeJS.Platform;
  /** The zip's bytes (nodejs.org by default). */
  download?: (url: string) => Promise<Buffer>;
  /** Windows' own tar.exe (bsdtar reads zip; Git Bash's GNU tar does not). */
  tar?: string;
  now?: () => number;
  /** Tests: the digests to expect instead of the pinned ones. */
  pin?: { exeSha256: string; treeSha256: string };
  /** The processes below Medium that hold anything under these folders (agentNodeHolders.ts by default); throws when it cannot tell. */
  holders?: (dirs: string[], o: { writesOnly: boolean }) => Promise<Holder[]>;
  /** Tests: how long to wait between tries of a rename refused while the holders end (2 s). */
  retryMs?: number;
}

export type AgentNodeResult = 'current' | 'installed' | 'busy' | 'skipped' | 'failed';

const fetchBytes = async (url: string): Promise<Buffer> => {
  const r = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};

/** Runs only the node.exe this run unpacked, in its own folder: never the installed one (w5839). */
async function versionOf(d: AgentNodeDeps, exe: string): Promise<string | undefined> {
  if (!fs.existsSync(exe)) return undefined;
  const r = await d.exec(exe, ['--version'], { timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/**
 * w5839: before w5717 a Low worker could rename `tools\node` aside and put its own node.exe there, which Medium agents,
 * BEAST's instance portals, the updater task and the elevated `worker.ts tools` run. w5717 closed that from its deploy
 * on; this finds one put there before. Nothing here runs the installed node: what is there is read from this record,
 * which `tools` (Medium) writes when it puts the pinned node there: the version, the SHA-256 of every file in the folder
 * and the folder's identity (`folderId`). It lives in `<root>\daemon\agent-node` (`agentNodeHome`), which no daemon
 * version labels Low, and whose labels are read before the record is; the records of before (`legacyStamps`), in
 * folders a rolled-back daemon labels Low, are never read.
 * Every tools run hashes the folder again, and a folder that is not the recorded one (a Low worker's copy of the pinned
 * bytes, its write handles kept open across a relabel: w5868's review) is put there again. The record must itself be the pinned download's (its files'
 * digest is `AGENT_NODE.treeSha256`), so one a Low worker wrote while `tools` was Low (before w5717, or a daemon
 * rolled back) cannot vouch for a planted DLL or script. A record that is not, a file that differs, is missing or was
 * added (a DLL beside node.exe loads before the system's), a link where the folder should be, or no record at all, is
 * a node put there again from a fresh pinned download. Matching bytes are not enough: a pinned copy a Low worker put
 * there with Low labels of its own matches every hash and stays writable from Low, so the labels and access entries are
 * read first (`labelProblem`, w5866's review).
 */
/**
 * The record's folder, where the fresh node is unpacked too: `<root>\daemon\agent-node`. `daemon` and `secrets` are the
 * root children every daemon version keeps Medium, from the first Windows fence on (w5377, 02cd43ca: MEDIUM_CHILDREN in
 * machine/lowIntegrity.ts). Before w5539 every other root child was labelled Low, `tools-medium` too, and nothing labels
 * it Medium again (w5876's review). Its labels are still read before the record is (`labelCheck`): a folder of it a Low
 * worker could write is put aside for a new one, and nothing in it is trusted.
 */
export const agentNodeHome = (root: string) => path.join(root, 'daemon', 'agent-node');
export const agentNodeStamp = (root: string) => path.join(agentNodeHome(root), 'record.json');
/**
 * Where the record lived before: `tools\node.json` (before w5868's review) and `tools-medium\agent-node.json` (before
 * w5876's), both in folders a rolled-back daemon labels Low. Never read; deleted once a record is written.
 */
const legacyStamps = (root: string) => [path.join(root, 'tools', 'node.json'), path.join(root, 'tools-medium', 'agent-node.json')];
type Stamp = { version: string; files: Record<string, string>; folder?: string };

/**
 * The identity of the folder at `p`: its volume and NTFS file id. A rename keeps it (also into another folder); a new
 * folder gets a new one (measured on BEAST's F:, w5839). A Low worker cannot give a folder it made the id of ours.
 */
export const folderId = (p: string): string => {
  const st = fs.statSync(p, { bigint: true });
  return `${st.dev}:${st.ino}`;
};
type Pin = { exeSha256: string; treeSha256: string };
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Every file under `dir` by its path inside it ('/'-joined): its SHA-256, or 'link' for a link or junction. A file with
 * more than one hard link is put in `linked` too: a handle opened through its other name has a path outside the folder.
 */
export function treeHashes(dir: string, linked?: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, rel: string): void => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const p = path.join(at, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out[r] = 'link';
      else if (e.isDirectory()) walk(p, r);
      else {
        out[r] = sha(p);
        if (linked && fs.statSync(p).nlink > 1) linked.push(r);
      }
    }
  };
  walk(dir, '');
  return out;
}

/** One digest of a whole tree: SHA-256 of "<path>\t<sha256>\n" for each file, in path order. */
export function treeDigest(files: Record<string, string>): string {
  return crypto.createHash('sha256').update(Object.keys(files).sort().map((k) => `${k}\t${files[k]}\n`).join('')).digest('hex');
}

/** How `got` differs from `want`, the first few files named; undefined when they are the same. */
export function treeDiff(want: Record<string, string>, got: Record<string, string>): string | undefined {
  const differs = Object.keys(want).filter((k) => k in got && got[k] !== want[k]);
  const missing = Object.keys(want).filter((k) => !(k in got));
  const added = Object.keys(got).filter((k) => !(k in want));
  const part = (word: string, l: string[]) => (l.length ? [`${l.length} ${word} (${l.sort().slice(0, 3).join(', ')}${l.length > 3 ? ', ...' : ''})`] : []);
  const said = [...part('differ', differs), ...part('missing', missing), ...part('added', added)];
  return said.length ? said.join('; ') : undefined;
}

/** A link or junction (or anything but a plain folder) at `p`; false when nothing is there. */
const notAFolder = (p: string): boolean => {
  let s: fs.Stats;
  try {
    s = fs.lstatSync(p);
  } catch {
    return false;
  }
  if (s.isSymbolicLink() || !s.isDirectory()) return true;
  // Node does not see a junction as a link on Windows (lstat says folder, readlink EINVAL; measured on Node v24.22.1,
  // w5839): where it resolves to does.
  try {
    const real = fs.realpathSync.native(p);
    return real.toLowerCase() !== path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p)).toLowerCase();
  } catch {
    return true;
  }
};

/** Whether the node at `dir` is the pinned one by its record; else why not. Reads files only. */
function stampCheck(stampFile: string, dir: string, pin: Pin): { ok: true; files: number } | { ok: false; why: string } {
  if (notAFolder(dir)) return { ok: false, why: `${dir} is a link or a file, not a folder` };
  if (!fs.existsSync(path.join(dir, 'node.exe'))) return { ok: false, why: 'no node.exe there' };
  let s: Stamp;
  try {
    if (!fs.lstatSync(stampFile).isFile()) throw new Error('not a plain file');
    s = JSON.parse(fs.readFileSync(stampFile, 'utf8')) as Stamp;
    if (typeof s.version !== 'string' || !s.files || typeof s.files !== 'object') throw new Error('not a record');
  } catch {
    return { ok: false, why: `no record of its install (${stampFile})` };
  }
  // The record is checked against the pin: one written by anyone else cannot vouch for another file.
  if (s.version !== AGENT_NODE.version || s.files['node.exe'] !== pin.exeSha256 || treeDigest(s.files) !== pin.treeSha256) {
    return { ok: false, why: `its record is not of the pinned ${AGENT_NODE.version}` };
  }
  // The folder must be the one this record was written for: one a Low worker made and filled with the pinned bytes,
  // its write handles kept open across a relabel, is another folder (w5868's review).
  let id: string;
  try {
    id = folderId(dir);
  } catch (e) {
    return { ok: false, why: `its folder could not be read (${(e as Error).message})` };
  }
  if (s.folder !== id) return { ok: false, why: `its record is of another folder (${s.folder ?? 'none named'}, not ${id})` };
  let now: Record<string, string>;
  const linked: string[] = [];
  try {
    now = treeHashes(dir, linked);
  } catch (e) {
    return { ok: false, why: `its files could not be read (${(e as Error).message})` };
  }
  const diff = treeDiff(s.files, now);
  // A second name for a file (a hard link a Low worker made while an old daemon had it writable) lets a handle opened
  // through that name write the file with a path the holder read never matches (w5886's review). The pinned download
  // has one name per file, so any second one means a fresh copy, whose files nobody else names.
  if (!diff && linked.length)
    return { ok: false, why: `${linked.length} of its files ${linked.length === 1 ? 'has' : 'have'} another hard link (${linked.sort().slice(0, 3).join(', ')}${linked.length > 3 ? ', ...' : ''})` };
  return diff ? { ok: false, why: `its files are not the recorded ones: ${diff}` } : { ok: true, files: Object.keys(now).length };
}

/**
 * What in `icacls <dir> /T` lets a Low worker write the node: a Low or Untrusted label, or any label below Medium; or an
 * access entry an entry in the tree holds of its own (not inherited), save the folder's own Medium label. A pinned copy
 * a Low worker put there while `tools` was Low (a daemon rolled back below w5717) and relabelled Low file by file keeps
 * those labels after the roll-forward (a file's own label beats an inherited one, w5377) and its bytes match the record,
 * so only its labels show it (w5866's review). Output this cannot read counts against the folder: the node is put there
 * again, which needs nobody. On BEAST's live `tools\node` every entry but the folder's Medium label is inherited (2459
 * entries in 5.3 s, measured). Labels are matched in English, as everywhere in machine/lowIntegrity.ts; another
 * language's names are unread labels, so that machine reinstalls each rollout rather than trusting them.
 */
export function labelProblem(out: string, dir: string): string | undefined {
  const lines = out.split(/\r?\n/);
  const sum = lines.find((l) => /^Successfully processed \d+ files; Failed processing (\d+) files/.test(l));
  if (!sum) return 'icacls did not finish';
  if (!/Failed processing 0 files/.test(sum)) return `icacls could not read some: ${sum.trim()}`;
  let entry = '';
  let root = true;
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === sum) break;
    if (!raw.trim()) {
      if (entry) root = false;
      continue;
    }
    let ace = raw.trim();
    if (!/^\s/.test(raw)) {
      // An entry's first line: its path, then its first access entry. The lines after it are indented to where that
      // entry starts, which is how the path is told from the entry (both hold spaces and backslashes).
      if (!raw.toLowerCase().startsWith(dir.toLowerCase())) return `icacls named ${raw.slice(0, 120)}, outside ${dir}`;
      const next = lines[i + 1] ?? '';
      const col = /^\s+\S/.test(next) ? next.length - next.trimStart().length : -1;
      if (col <= dir.length || raw[col - 1] !== ' ') return `icacls line not read: ${raw.slice(0, 120)}`;
      entry = raw.slice(0, col - 1);
      ace = raw.slice(col);
      seen++;
    }
    const flags = ace.slice(ace.lastIndexOf(':') + 1);
    if (!/^(\([A-Z,]+\))+$/.test(flags)) return `icacls line not read: ${ace.slice(0, 120)}`;
    const label = /\((NW|NR|NX)\)/.test(flags) || /Mandatory Label\\/i.test(ace);
    if (label && !/^Mandatory Label\\(Medium|Medium Plus|High|System) Mandatory Level:/i.test(ace)) return `${entry} is labelled ${ace}`;
    if (!flags.includes('(I)') && !(root && label)) return `${entry} holds an access entry of its own: ${ace}`;
  }
  return seen ? undefined : 'icacls named nothing';
}

async function labelCheck(dir: string, d: AgentNodeDeps): Promise<string | undefined> {
  const r = await d.exec('icacls', [dir, '/T', '/C'], { timeoutMs: 5 * 60_000 });
  const p = r.code === 0 ? labelProblem(r.stdout, dir) : `icacls could not read it (${r.code}: ${(r.stderr || r.stdout).trim().slice(-200)})`;
  return p && `its labels let a Low worker write it: ${p}`;
}

async function readHolders(dirs: string[], writesOnly: boolean, d: AgentNodeDeps): Promise<Holder[]> {
  if (d.holders) return d.holders(dirs, { writesOnly });
  const script = Buffer.from(holdersScript(dirs, [process.pid], writesOnly), 'utf16le').toString('base64');
  const r = await d.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', script], { timeoutMs: 5 * 60_000 });
  const got = r.code === 0 ? parseHolders(r.stdout) : undefined;
  if (!got) throw new Error(`the read of the processes holding them failed (${r.code}: ${(r.stderr || r.stdout).replace(/\s+/g, ' ').trim().slice(-200)})`);
  return got;
}

/**
 * Names, in a WARNING, every process below Medium that holds the node's folder or its record's folder (w5882's review).
 * With `writesOnly` (the check before the node is trusted), only access that can change them counts: a write handle a Low
 * worker took while an old daemon had `tools` Low outlives the relabel, so it could write node.exe after the check, while a
 * Low worker that runs this node or works in its folder holds read handles only and is not named (w5886's review).
 * Without it (a swap the folder refused), any handle or view counts, since any file or folder held open stops the rename.
 * Nothing is ended: this is the warn-only stage lothsahn's lockout rule asks for first (w5926's review); a node some Low
 * process can write is swapped instead, and the old one moved aside leaves that handle on a file nothing runs. Answers why
 * the node cannot be trusted this run, or nothing when no Low process held either folder.
 */
async function warnLowHolders(dirs: string[], writesOnly: boolean, d: AgentNodeDeps): Promise<string | undefined> {
  const there = dirs.filter((x) => fs.existsSync(x));
  if (!there.length) return undefined;
  let held: Holder[];
  try {
    held = await readHolders(there, writesOnly, d);
  } catch (e) {
    return `could not tell which processes hold it open: ${(e as Error).message}`;
  }
  if (!held.length) return undefined;
  const list = held.map((h) => `${h.name} (${h.pid}) ${h.path}`).join('; ');
  d.say(
    writesOnly
      ? `WARNING: Agent node: processes below Medium integrity hold write access to the node's folders, so they could change it after the check: ${list}; the node is not trusted, and they are not ended.`
      : `WARNING: Agent node: processes below Medium integrity hold the node's folder open, so the swap cannot pass: ${list}; they are not ended.`,
  );
  return `${writesOnly ? 'Low processes held write access to it' : 'Low processes held it open'}: ${held.map((h) => `${h.name} (${h.pid})`).join(', ')}`;
}

/** How long a stage folder is taken to be another rollout's, still running (an unpack takes seconds: 1.8 s measured). */
const STAGE_TTL_MS = 60 * 60_000;

/** Deletes a path; false when it could not. Never throws. */
function remove(p: string): boolean {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The old node folders an earlier swap could not delete, and staging folders a run left, deleted once nothing holds
 * them. Windows lets a folder be renamed while a node.exe in it runs, but not deleted (EPERM; measured on BEAST, w5839):
 * the agents that run from it keep it until they end. Each run stages in a folder of its own, so one left behind never
 * stops the next.
 */
function sweepOld(tools: string, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(tools);
  } catch {
    return;
  }
  for (const n of names) {
    // Another rollout's stage of the last hour may still be in use (w5866's review): it is left to that run.
    const part = /^node-v[\d.]+(?:-(\d+))?\.part$/.exec(n);
    if (/^node\.old-\d+$/.test(n) || (part && !(part[1] && now - Number(part[1]) < STAGE_TTL_MS))) remove(path.join(tools, n));
  }
}

/** Deletes the record folders an earlier run put aside (one still held open waits for a later run). */
function sweepAside(daemonDir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(daemonDir);
  } catch {
    return;
  }
  for (const n of names) if (/^agent-node\.old-\d+$/.test(n)) remove(path.join(daemonDir, n));
}

/**
 * The pinned zip's bytes: the copy kept in the record's folder when its SHA-256 is the pinned one, else a download, kept
 * there for the next rollout (every rollout swaps the node, w5964's review, so it needs no network once one has it). The
 * bytes are hashed in memory and those same bytes unpacked, so nothing that changes the kept file after the read counts.
 */
async function pinnedZip(medium: string, d: AgentNodeDeps): Promise<Buffer> {
  const kept = path.join(medium, AGENT_NODE.zip);
  const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
  try {
    const b = fs.readFileSync(kept);
    if (sha(b) === AGENT_NODE.sha256) return b;
  } catch {
    // none kept yet
  }
  const bytes = await (d.download ?? fetchBytes)(`https://nodejs.org/dist/${AGENT_NODE.version}/${AGENT_NODE.zip}`);
  const sum = sha(bytes);
  if (sum !== AGENT_NODE.sha256) throw new Error(`${AGENT_NODE.zip} has SHA-256 ${sum}, not the pinned ${AGENT_NODE.sha256}`);
  try {
    // Older versions' zips go: one is kept.
    for (const n of fs.readdirSync(medium)) if (/^node-v[\d.]+-win-.*\.zip(\.part)?$/.test(n) && n !== AGENT_NODE.zip) remove(path.join(medium, n));
    fs.writeFileSync(`${kept}.part`, bytes);
    fs.renameSync(`${kept}.part`, kept);
  } catch {
    // Not kept: the next rollout downloads it again.
  }
  return bytes;
}

/**
 * Put a fresh copy of the pinned node at `<root>\tools\node` on every run, from the zip kept in the record's folder
 * (`pinnedZip`). Everything it writes stays in `<root>\tools` and `<root>\daemon\agent-node`. Each run says one line the
 * rollout log keeps: "node reinstalled (why)", where why starts "verified: ..." when the node there passed every check,
 * or a WARNING "node not reinstalled (why)" when it could not, and then the node there stays (lothsahn's lockout rule:
 * never leave the machine without node). A folder that cannot be moved aside keeps its node: 'busy', and the next rollout
 * tries again. The checks no longer decide whether to swap (w5964's review: a Low process can hide a write handle from
 * the holder read), only what the line says; 'current' is never returned now.
 *
 * A node with no record is always swapped for the fresh one, even when its files match: a folder this run unpacked and
 * labelled Medium is known to be nobody else's, while one a Low worker could once write may hold a Low label of its own
 * (one swap per machine, w5839's review).
 */
export async function ensureAgentNode(root: string, d: AgentNodeDeps): Promise<AgentNodeResult> {
  if (d.platform !== 'win32') return 'skipped';
  const dir = agentNodeDir(root);
  const stampFile = agentNodeStamp(root);
  const pin = d.pin ?? { exeSha256: AGENT_NODE.exeSha256, treeSha256: AGENT_NODE.treeSha256 };
  const tools = path.dirname(dir);
  const medium = agentNodeHome(root);
  const daemonDir = path.dirname(medium);
  sweepOld(tools, (d.now ?? Date.now)());
  sweepOld(medium, (d.now ?? Date.now)());
  sweepAside(daemonDir);
  // The record's folder first (w5876's review): a record a Low worker could write vouches for nothing, and a stage in a
  // folder it can write could be held open. Such a folder goes aside, unread, for a new one; one that cannot keeps the
  // node there (lothsahn's lockout rule).
  const homeBad = notAFolder(medium)
    ? 'is a link or a file, not a folder'
    : fs.existsSync(medium)
      ? (await labelCheck(medium, d))?.replace(/^its labels let/, 'has labels that let')
      : undefined;
  if (homeBad) {
    const aside = path.join(daemonDir, `agent-node.old-${(d.now ?? Date.now)()}`);
    try {
      fs.renameSync(medium, aside);
    } catch (e) {
      d.say(`WARNING: Agent node: node not checked: its record's folder ${medium} ${homeBad} and could not be put aside (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); the node there stays until the next rollout.`);
      return 'failed';
    }
    remove(aside);
  }
  // The processes below Medium with write access to either folder (w5882's review): a handle outlives a relabel, so
  // a folder some Low process can still write is never trusted, whatever its labels and hashes say. They are named, not
  // ended (w5926's review), and the node swapped. A Low process with read handles only (running this node, working in its
  // folder) is not named (w5886's review).
  // The labels first, then the holders (w5951's review, N3): once the labels let no Low process open the files for writing,
  // no new write handle can appear, so the holder read after them sees every one there will be, and what is hashed next
  // stays what runs.
  const lab = !homeBad && !notAFolder(dir) && fs.existsSync(path.join(dir, 'node.exe')) ? await labelCheck(dir, d) : undefined;
  const held = homeBad || lab || notAFolder(dir) ? undefined : await warnLowHolders([dir, medium], true, d);
  const st = homeBad
    ? { ok: false as const, why: `its record's folder ${homeBad}` }
    : lab
      ? { ok: false as const, why: lab }
      : held
        ? { ok: false as const, why: held }
        : stampCheck(stampFile, dir, pin);
  // A node that passes every check is swapped all the same (w5964's review, B1): a Low process can hide a write handle
  // from the holder read by moving it to a new handle value while the read copies them one at a time (measured: named in
  // 0 of 12 reads), so the read cannot vouch for it. A fresh copy is Medium from birth and no handle to the old one
  // reaches it; the checks above still name what they find, in the line.
  const why = st.ok
    ? `verified: node.exe and its ${st.files} files match the record of the pinned download, no Low label or access entry of their own lets a Low worker write them, and the holder read named no process below Medium with write access; swapped anyway, since a Low process can hide a write handle from that read`
    : st.why;
  // Unpacked in the record's folder, which no daemon labels Low (`agentNodeHome`): its files are Medium from birth, so no
  // Low worker ever holds a handle to one, even while `tools` is Low (w5868's review). A rename keeps them so on the way to
  // `tools\node`, on the same volume.
  const stage = path.join(medium, `node-${AGENT_NODE.version}-${(d.now ?? Date.now)()}.part`);
  try {
    fs.mkdirSync(tools, { recursive: true });
    fs.mkdirSync(medium, { recursive: true });
    fs.mkdirSync(stage);
    const bytes = await pinnedZip(medium, d);
    const zip = path.join(stage, AGENT_NODE.zip);
    fs.writeFileSync(zip, bytes);
    const tar = d.tar ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    const x = await d.exec(tar, ['-xf', zip, '-C', stage], { timeoutMs: 10 * 60_000 });
    if (x.code !== 0) throw new Error(`tar could not unpack ${zip}: ${(x.stderr || x.stdout).trim().slice(-300)}`);
    const unpacked = path.join(stage, AGENT_NODE.zip.replace(/\.zip$/, ''));
    // Medium on its own label before it is hashed: a daemon that starts during this run labels each other folder in
    // tools Low (machine/lowIntegrity.ts lowTargets), this one too. Hashed after, so what was written before is seen.
    const lab = await d.exec('icacls', [unpacked, '/setintegritylevel', '(OI)(CI)medium'], { timeoutMs: 30 * 60_000 });
    if (lab.code !== 0) throw new Error(`could not label ${unpacked} Medium: ${(lab.stderr || lab.stdout).trim().slice(-200)}`);
    const fresh = treeHashes(unpacked);
    if (fresh['node.exe'] !== pin.exeSha256) throw new Error(`the unpacked node.exe has SHA-256 ${fresh['node.exe'] ?? 'none'}, not the pinned ${pin.exeSha256}`);
    if (treeDigest(fresh) !== pin.treeSha256) throw new Error(`the unpacked files' digest is ${treeDigest(fresh)}, not the pinned ${pin.treeSha256}`);
    const got = await versionOf(d, path.join(unpacked, 'node.exe'));
    if (got !== AGENT_NODE.version) throw new Error(`the unpacked node says ${got ?? 'nothing'}, not ${AGENT_NODE.version}`);
    let old: string | undefined;
    if (fs.existsSync(dir) || notAFolder(dir)) {
      old = path.join(tools, `node.old-${(d.now ?? Date.now)()}`);
      // A file or folder in it held open refuses the rename (w5882's review: a Low process holding one kept a planted node
      // in place on every rollout). The holders below Medium are named once, nothing is ended (w5926's review: the warn-only
      // stage), and the rename tried again after a moment; a folder still held keeps its node until the next rollout.
      let busy: string | undefined;
      let named: string | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          fs.renameSync(dir, old);
          busy = undefined;
          break;
        } catch (e) {
          busy = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
          if (attempt === 2) break;
          if (attempt === 0) named = await warnLowHolders([dir], false, d);
          await new Promise((res) => setTimeout(res, d.retryMs ?? 2000));
        }
      }
      if (busy) {
        d.say(`WARNING: Agent node: node not reinstalled (${why}): ${dir} is still in use (${busy}${named ? `; ${named}` : ''}); nothing is ended, and the node there stays until the next rollout.`);
        remove(stage);
        return 'busy';
      }
    }
    try {
      fs.renameSync(unpacked, dir);
    } catch (e) {
      // Never leave the machine without node: the old folder goes back, and if even that fails, the line says where it is.
      if (old) {
        try {
          fs.renameSync(old, dir);
        } catch (back) {
          d.say(`WARNING: Agent node: node not reinstalled (${why}): ${dir} is MISSING: the new node could not be moved in (${(e as Error).message}) nor the old one back from ${old} (${(back as Error).message}); the next rollout puts one there.`);
          remove(stage);
          return 'failed';
        }
      } else {
        d.say(`WARNING: Agent node: node not reinstalled (${why}): ${dir} is MISSING: there was none and the new one could not be moved in (${(e as Error).message}); the next rollout puts one there.`);
        remove(stage);
        return 'failed';
      }
      throw e;
    }
    let unrecorded = '';
    try {
      remove(`${stampFile}.part`);
      fs.writeFileSync(`${stampFile}.part`, `${JSON.stringify({ version: AGENT_NODE.version, files: fresh, folder: folderId(dir) } satisfies Stamp)}\n`);
      fs.renameSync(`${stampFile}.part`, stampFile);
      for (const l of legacyStamps(root)) remove(l);
    } catch (e) {
      unrecorded = `; WARNING: its record could not be written (${(e as Error).message}), so the next rollout puts it there again`;
    }
    remove(stage);
    const kept = old && !remove(old) ? ` (${path.basename(old)} is still in use by a node that runs from it; a later rollout deletes it)` : '';
    d.say(`Agent node: node reinstalled (${why}): ${AGENT_NODE.version} at ${dir}; the daemon puts it first on its agents' PATH${kept}${unrecorded}.`);
    return 'installed';
  } catch (e) {
    remove(stage);
    const left = fs.existsSync(path.join(dir, 'node.exe')) ? 'the node there stays' : `${dir} has no node yet; the next rollout tries again`;
    d.say(`WARNING: Agent node: node not reinstalled (${why}): could not put ${AGENT_NODE.version} at ${dir}: ${(e as Error).message}; ${left}.`);
    return 'failed';
  }
}

/** The folder to put first on an agent's PATH: the root's agent node, once it is there (Windows). */
export function agentNodePathDir(root: string | undefined, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  if (!root || platform !== 'win32') return undefined;
  return exists(agentNodeExe(root)) ? agentNodeDir(root) : undefined;
}

/** How Windows Firewall shows firewall.ps1's tailnet ($Tailnet: 100.64.0.0/10, fd7a:115c:a1e0::/48) in a rule's RemoteAddress. */
export const TAILNET_FORMS = ['100.64.0.0/255.192.0.0', '100.64.0.0/10', 'fd7a:115c:a1e0::/48'];

/**
 * The PowerShell that reads, with no administrator rights, whether Windows Firewall lets each program listen without a
 * prompt (w1742): "ok <path>" when an enabled inbound Allow rule names that exact path and no enabled Block does, else
 * "missing <path>"; then "stale=<n>", the inbound rules earlier prompts left for programs under `tmp` (outside the
 * install's own "Final Factory ..." groups), which firewall.ps1 -StaleUnder deletes. Three bulk reads (every application
 * filter, every address filter, every inbound rule) joined on the rule's id: one Get-NetFirewallApplicationFilter per
 * path took about 2.5 s each on lothdesktop's 696 rules (player_slots.py firewall, measured).
 *
 * For each path in `tailnetOnly` (w5581: the agents' node and ffu-server take connections from the tailnet only):
 * "from <path> <addresses>" for each enabled Allow rule naming it, and "wide <path>" unless every such rule's
 * RemoteAddress is the tailnet only (TAILNET_FORMS). A rule is narrow only when its addresses are read and positively
 * tailnet: BEAST's node rule allowed Any (the ops worker's elevated read, 2026-11-25) while the earlier check, which
 * looked for 'Any' in the bulk read, printed "tailnet only" on every tools run. A rule the bulk read has no address
 * filter for is read again on its own. Then "peer <path> <address>" for each connection that path's running process
 * has from outside loopback and the tailnet: what narrowing the rule would cut off; "peers notrunning <path>" or
 * "peers unread <path>" when that could not be seen, never a silent "none". "read ..." gives the counts read.
 */
export function firewallCheckScript(exes: string[], tmp: string, tailnetOnly: string[] = []): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const under = `${path.win32.resolve(tmp).replace(/\\+$/, '')}\\`.toLowerCase();
  const narrow = tailnetOnly.length ? `@(${tailnetOnly.map(q).join(', ')})` : '@()';
  return `$ErrorActionPreference = 'Stop'
$progs = @{}
$apps = @(Get-NetFirewallApplicationFilter)
foreach ($f in $apps) { if ($f.Program) { $progs[[string]$f.InstanceID] = ([string]$f.Program).ToLowerInvariant() } }
$from = @{}
$addrs = @(Get-NetFirewallAddressFilter)
foreach ($a in $addrs) { $from[[string]$a.InstanceID] = @($a.RemoteAddress | ForEach-Object { [string]$_ }) }
$allow = @{}; $block = @{}; $rules = @{}; $stale = 0
$inbound = @(Get-NetFirewallRule -Direction Inbound)
foreach ($r in $inbound) {
  $p = $progs[[string]$r.Name]
  if (-not $p) { continue }
  if ([string]$r.Enabled -eq 'True') { if ([string]$r.Action -eq 'Allow') { $allow[$p] = 1; $rules[$p] = @($rules[$p]) + [string]$r.Name } elseif ([string]$r.Action -eq 'Block') { $block[$p] = 1 } }
  if ($p.StartsWith(${q(under)}) -and ([string]$r.Group) -notlike 'Final Factory*') { $stale++ }
}
"read apps=$($apps.Count) addrs=$($addrs.Count) inbound=$($inbound.Count)"
foreach ($e in @(${exes.map(q).join(', ')})) {
  $k = $e.ToLowerInvariant()
  if ($allow[$k] -and -not $block[$k]) { "ok $e" } else { "missing $e" }
}
$tailnet = @(${TAILNET_FORMS.map(q).join(', ')})
$procs = $null
if (${narrow}.Count) {
  try { $procs = @{}; foreach ($pr in @(Get-Process -ErrorAction SilentlyContinue)) { try { $pp = [string]$pr.Path } catch { $pp = '' }; if ($pp) { $pl = $pp.ToLowerInvariant(); $procs[$pl] = @($procs[$pl]) + $pr.Id } } } catch { $procs = $null }
}
foreach ($e in ${narrow}) {
  $k = $e.ToLowerInvariant()
  $wideSaid = $false
  try {
  $isWide = $false
  foreach ($n in @($rules[$k] | Where-Object { $_ })) {
    $ra = $from[$n]
    if ($null -eq $ra) { try { $ra = @(Get-NetFirewallRule -Name $n | Get-NetFirewallAddressFilter | ForEach-Object { $_.RemoteAddress } | ForEach-Object { [string]$_ }) } catch { $ra = @() } }
    "from $e $(@($ra) -join ',')"
    if (-not @($ra).Count -or @($ra | Where-Object { $tailnet -notcontains $_ }).Count) { $isWide = $true }
  }
  if ($isWide) { "wide $e"; $wideSaid = $true }
  try {
    if ($null -eq $procs) { throw 'no process list' }
    $ids = @($procs[$k] | Where-Object { $_ })
    if (-not $ids.Count) { "peers notrunning $e" } else {
      $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $ids -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalPort })
      foreach ($c in @(Get-NetTCPConnection -State Established -OwningProcess $ids -ErrorAction SilentlyContinue)) {
        $ra = [string]$c.RemoteAddress
        if ($ports -notcontains $c.LocalPort) { continue }
        if ($ra -eq '::1' -or $ra.StartsWith('127.') -or $ra.StartsWith('::ffff:127.')) { continue }
        $v4 = $ra -replace '^::ffff:', ''
        $o = $v4.Split('.')
        if ($o.Count -eq 4 -and ($o[0] -as [int]) -eq 100 -and ($o[1] -as [int]) -ge 64 -and ($o[1] -as [int]) -le 127) { continue }
        if ($ra.ToLowerInvariant().StartsWith('fd7a:115c:a1e0:')) { continue }
        "peer $e $($ra):$($c.LocalPort)"
      }
    }
  } catch { "peers unread $e" }
  } catch { if (-not $wideSaid) { "wide $e" }; "from $e unread: $($_.Exception.Message -replace '\\s+', ' ')" }
}
"stale=$stale"
`;
}

/**
 * firewallCheckScript's answer: the paths without an allow rule, the tailnet-only paths an allow rule opens to any
 * address (w5581), and the count of stale temp rules; undefined when unreadable.
 */
export function parseFirewallCheck(out: string): { missing: string[]; wide: string[]; stale: number; from: string[]; peers: string[]; peersUnknown: string[]; read?: string } | undefined {
  const lines = out.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const stale = lines.map((l) => /^stale=(\d+)$/.exec(l)).find(Boolean);
  if (!stale) return undefined;
  const after = (word: string) => lines.filter((l) => l.startsWith(`${word} `)).map((l) => l.slice(word.length + 1));
  const read = lines.find((l) => l.startsWith('read '))?.slice(5);
  return { missing: after('missing'), wide: after('wide'), stale: Number(stale[1]), from: after('from'), peers: after('peer'), peersUnknown: after('peers'), ...(read ? { read } : {}) };
}
