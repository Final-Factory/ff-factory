import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
 * which `tools` (Medium) writes beside it when it puts the pinned node there: the version and the SHA-256 of every file
 * in the folder. Every tools run hashes the folder again. The record must itself be the pinned download's (its files'
 * digest is `AGENT_NODE.treeSha256`), so one a Low worker wrote while `tools` was Low (before w5717, or a daemon
 * rolled back) cannot vouch for a planted DLL or script. A record that is not, a file that differs, is missing or was
 * added (a DLL beside node.exe loads before the system's), a link where the folder should be, or no record at all, is
 * a node put there again from a fresh pinned download.
 */
export const agentNodeStamp = (root: string) => path.join(root, 'tools', 'node.json');
type Stamp = { version: string; files: Record<string, string> };
type Pin = { exeSha256: string; treeSha256: string };
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Every file under `dir` by its path inside it ('/'-joined): its SHA-256, or 'link' for a link or junction. */
export function treeHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, rel: string): void => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const p = path.join(at, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out[r] = 'link';
      else if (e.isDirectory()) walk(p, r);
      else out[r] = sha(p);
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
  let now: Record<string, string>;
  try {
    now = treeHashes(dir);
  } catch (e) {
    return { ok: false, why: `its files could not be read (${(e as Error).message})` };
  }
  const diff = treeDiff(s.files, now);
  return diff ? { ok: false, why: `its files are not the recorded ones: ${diff}` } : { ok: true, files: Object.keys(now).length };
}

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
function sweepOld(tools: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(tools);
  } catch {
    return;
  }
  for (const n of names) if (/^node\.old-\d+$/.test(n) || /^node-v[\d.]+(-\d+)?\.part$/.test(n)) remove(path.join(tools, n));
}

/**
 * Put the pinned node at `<root>\tools\node`, unless the record says it is there already. Everything it writes stays in
 * `<root>\tools`. Each run says one line the rollout log keeps: "node verified", or "node reinstalled (why)", or a WARNING
 * "node not reinstalled (why)" when it could not, and then the node there stays (lothsahn's lockout rule: never leave the
 * machine without node). A folder that cannot be moved aside keeps its node: 'busy', and the next rollout tries again.
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
  sweepOld(tools);
  const st = stampCheck(stampFile, dir, pin);
  if (st.ok) {
    d.say(`Agent node: node verified: ${AGENT_NODE.version} at ${dir} (node.exe and its ${st.files} files match the record of the pinned download).`);
    return 'current';
  }
  const why = st.why;
  const stage = path.join(tools, `node-${AGENT_NODE.version}-${(d.now ?? Date.now)()}.part`);
  try {
    fs.mkdirSync(tools, { recursive: true });
    fs.mkdirSync(stage);
    const url = `https://nodejs.org/dist/${AGENT_NODE.version}/${AGENT_NODE.zip}`;
    const bytes = await (d.download ?? fetchBytes)(url);
    const sum = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sum !== AGENT_NODE.sha256) throw new Error(`${AGENT_NODE.zip} has SHA-256 ${sum}, not the pinned ${AGENT_NODE.sha256}`);
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
      try {
        fs.renameSync(dir, old);
      } catch (e) {
        d.say(`WARNING: Agent node: node not reinstalled (${why}): ${dir} is in use (${(e as NodeJS.ErrnoException).code}); the node there stays until the next rollout.`);
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
      }
      throw e;
    }
    let unrecorded = '';
    try {
      remove(`${stampFile}.part`);
      fs.writeFileSync(`${stampFile}.part`, `${JSON.stringify({ version: AGENT_NODE.version, files: fresh } satisfies Stamp)}\n`);
      fs.renameSync(`${stampFile}.part`, stampFile);
    } catch (e) {
      unrecorded = `; WARNING: its record could not be written (${(e as Error).message}), so the next rollout puts it there again`;
    }
    remove(stage);
    const kept = old && !remove(old) ? ` (${path.basename(old)} is still in use by a node that runs from it; a later rollout deletes it)` : '';
    d.say(`Agent node: node reinstalled (${why}): ${AGENT_NODE.version} at ${dir}; the daemon puts it first on its agents' PATH${kept}${unrecorded}.`);
    return 'installed';
  } catch (e) {
    remove(stage);
    d.say(`WARNING: Agent node: node not reinstalled (${why}): could not put ${AGENT_NODE.version} at ${dir}: ${(e as Error).message}; the node there stays.`);
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
