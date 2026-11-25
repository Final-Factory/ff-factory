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
 * node.exe inside that zip (w5839: unpacked with Windows' tar.exe and hashed, 2026-11-25; BEAST's tools\node\node.exe had
 * the same digest, and all 1994 files of its tools\node matched the zip's).
 */
export const AGENT_NODE = {
  version: 'v24.22.1',
  zip: 'node-v24.22.1-win-x64.zip',
  sha256: 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
  exeSha256: 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5',
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
  /** Tests: the node.exe digest to expect instead of the pinned one. */
  exeSha256?: string;
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
 * in the folder. Every tools run hashes the folder again. A record whose node.exe is not the pinned one, a file that
 * differs, is missing or was added (a DLL beside node.exe loads before the system's), or no record at all, is a node
 * checked against a fresh pinned download and put there again when it differs.
 */
export const agentNodeStamp = (root: string) => path.join(root, 'tools', 'node.json');
type Stamp = { version: string; files: Record<string, string> };
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

/** How `got` differs from `want`, the first few files named; undefined when they are the same. */
export function treeDiff(want: Record<string, string>, got: Record<string, string>): string | undefined {
  const differs = Object.keys(want).filter((k) => k in got && got[k] !== want[k]);
  const missing = Object.keys(want).filter((k) => !(k in got));
  const added = Object.keys(got).filter((k) => !(k in want));
  const part = (word: string, l: string[]) => (l.length ? [`${l.length} ${word} (${l.sort().slice(0, 3).join(', ')}${l.length > 3 ? ', ...' : ''})`] : []);
  const said = [...part('differ', differs), ...part('missing', missing), ...part('added', added)];
  return said.length ? said.join('; ') : undefined;
}

/** Whether the node at `dir` is the pinned one by its record; else why not. Reads files only. */
function stampCheck(stampFile: string, dir: string, exeSha: string): { ok: true; files: number } | { ok: false; why: string } {
  if (!fs.existsSync(path.join(dir, 'node.exe'))) return { ok: false, why: 'no node.exe there' };
  let s: Stamp;
  try {
    s = JSON.parse(fs.readFileSync(stampFile, 'utf8')) as Stamp;
    if (typeof s.version !== 'string' || !s.files || typeof s.files !== 'object') throw new Error('not a record');
  } catch {
    return { ok: false, why: `no record of its install (${stampFile})` };
  }
  // The record is checked against the pin too: one written by anyone else cannot vouch for another node.exe.
  if (s.version !== AGENT_NODE.version || s.files['node.exe'] !== exeSha) return { ok: false, why: `its record is not of the pinned ${AGENT_NODE.version}` };
  let now: Record<string, string>;
  try {
    now = treeHashes(dir);
  } catch (e) {
    return { ok: false, why: `its files could not be read (${(e as Error).message})` };
  }
  const diff = treeDiff(s.files, now);
  return diff ? { ok: false, why: `its files are not the recorded ones: ${diff}` } : { ok: true, files: Object.keys(now).length };
}

/**
 * Deletes an old node folder; false when it could not. Windows lets a folder be renamed while a node.exe in it runs, but
 * not deleted (EPERM; measured on BEAST, w5839): the agents that run from it keep it until they end.
 */
function removeOld(old: string): boolean {
  try {
    fs.rmSync(old, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** The old node folders an earlier swap could not delete, deleted once nothing runs from them. */
function sweepOld(tools: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(tools);
  } catch {
    return;
  }
  for (const n of names) if (/^node\.old-\d+$/.test(n)) removeOld(path.join(tools, n));
}

/**
 * Put the pinned node at `<root>\tools\node`, unless the record says it is there already. Everything it writes stays in
 * `<root>\tools`. Each run says one line the rollout log keeps: "node verified", or "node reinstalled (why)", or a WARNING
 * "node not reinstalled (why)" when it could not, and then the node there stays (lothsahn's lockout rule: never leave the
 * machine without node). A folder that cannot be moved aside keeps its node: 'busy', and the next rollout tries again.
 */
export async function ensureAgentNode(root: string, d: AgentNodeDeps): Promise<AgentNodeResult> {
  if (d.platform !== 'win32') return 'skipped';
  const dir = agentNodeDir(root);
  const stampFile = agentNodeStamp(root);
  const exeSha = d.exeSha256 ?? AGENT_NODE.exeSha256;
  sweepOld(path.dirname(dir));
  const st = stampCheck(stampFile, dir, exeSha);
  if (st.ok) {
    d.say(`Agent node: node verified: ${AGENT_NODE.version} at ${dir} (node.exe and its ${st.files} files match the record of the pinned download).`);
    return 'current';
  }
  const why = st.why;
  const tools = path.dirname(dir);
  const stage = path.join(tools, `node-${AGENT_NODE.version}.part`);
  try {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
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
    const fresh = treeHashes(unpacked);
    if (fresh['node.exe'] !== exeSha) throw new Error(`the unpacked node.exe has SHA-256 ${fresh['node.exe'] ?? 'none'}, not the pinned ${exeSha}`);
    const got = await versionOf(d, path.join(unpacked, 'node.exe'));
    if (got !== AGENT_NODE.version) throw new Error(`the unpacked node says ${got ?? 'nothing'}, not ${AGENT_NODE.version}`);
    const stamp = (): void => {
      fs.writeFileSync(`${stampFile}.part`, `${JSON.stringify({ version: AGENT_NODE.version, files: fresh } satisfies Stamp)}\n`);
      fs.renameSync(`${stampFile}.part`, stampFile);
    };
    // A node from before the record (w5839) whose files are the pinned download's: recorded, not swapped.
    if (fs.existsSync(dir)) {
      let there: Record<string, string> | undefined;
      try {
        there = treeHashes(dir);
      } catch {
        there = undefined;
      }
      if (there && !treeDiff(fresh, there)) {
        stamp();
        fs.rmSync(stage, { recursive: true, force: true });
        d.say(`Agent node: node verified: ${AGENT_NODE.version} at ${dir} (${why}; its ${Object.keys(fresh).length} files match a fresh pinned download, recorded).`);
        return 'current';
      }
    }
    let old: string | undefined;
    if (fs.existsSync(dir)) {
      old = path.join(tools, `node.old-${(d.now ?? Date.now)()}`);
      try {
        fs.renameSync(dir, old);
      } catch (e) {
        d.say(`WARNING: Agent node: node not reinstalled (${why}): ${dir} is in use (${(e as NodeJS.ErrnoException).code}); the node there stays until the next rollout.`);
        fs.rmSync(stage, { recursive: true, force: true });
        return 'busy';
      }
    }
    try {
      fs.renameSync(unpacked, dir);
    } catch (e) {
      // Never leave the machine without node: the old folder goes back.
      if (old) fs.renameSync(old, dir);
      throw e;
    }
    stamp();
    fs.rmSync(stage, { recursive: true, force: true });
    const kept = old && !removeOld(old) ? ` (${path.basename(old)} is still in use by a node that runs from it; a later rollout deletes it)` : '';
    d.say(`Agent node: node reinstalled (${why}): ${AGENT_NODE.version} at ${dir}; the daemon puts it first on its agents' PATH${kept}.`);
    return 'installed';
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
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
