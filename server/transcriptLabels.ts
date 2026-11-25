/**
 * w5703: the Windows half of "transcripts are read-only to workers" (w5563, docs/transcript-seal.md). With the Low
 * integrity fence on (machine/lowIntegrity.ts) and daemon.json `workerTranscriptLabels: true`, `<CLAUDE_CONFIG_DIR>\projects`
 * carries an explicit Medium no-write-up label, inherited by every project folder and every transcript in it: a Low worker
 * cannot plant, edit, rename or delete a transcript there, nor make a folder. Only the conversation a claude process runs
 * is Low while that process lives: its `<id>.jsonl` and its `<id>\` folder (tool results, subagents), labelled by the agent
 * host before the process starts and labelled Medium again once it has exited.
 *
 * A new conversation's file cannot be made ahead: the CLI refuses `--session-id <id>` when `<id>.jsonl` exists ("Session ID
 * ... is already in use", a statSync at start-up). So the spawner holds back the SDK's first user message until the CLI has
 * answered the SDK's `initialize` (its start-up check is behind it then), makes the empty file, labels it Low and lets the
 * message through; the CLI appends to it (measured on BEAST, Claude Code 2.1.x against a mock API: a new conversation, a
 * resume and a /compact ran with the project folder refusing new files and folders, the transcript kept its first bytes
 * through each, and `memory\` was simply not made).
 *
 * What it does not do: another live conversation's own file is Low while its process runs, so a Low worker can write it
 * (every worker is the same user at the same level); the seal (server/transcriptSeal.ts) fails such an edit at its next
 * resume. A host that dies before its claude leaves that conversation Low until its next process ends.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { findTranscript, projectSlug } from './claudeHome.ts';
import { sessionIdOf } from './workerFence.ts';
import { currentAccount, type Exec } from '../machine/lowIntegrity.ts';

/** The folder label (inherited by what is made inside) and the file label. */
const DIR_LOW = '(OI)(CI)low';
const DIR_MEDIUM = '(OI)(CI)medium';

/** Sets a label with icacls, synchronously; Runs icacls `args` and answers its exit code and output. */
export type IcaclsSync = (args: string[]) => { code: number; out: string };

const realIcacls: IcaclsSync = (args) => {
  try {
    return { code: 0, out: execFileSync('icacls', args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string; message: string };
    return { code: x.status ?? 1, out: `${x.stdout ?? ''}${x.stderr ?? ''}` || x.message };
  }
};

/**
 * Sets `label` on `p`. Setting a label needs WRITE_OWNER; where the account has it only through a group ACE icacls answers
 * "Access is denied", and the owner may still grant itself Full first (lowIntegrity.ts labelLow, measured w5402).
 */
export function setLabelSync(p: string, label: string, icacls: IcaclsSync = realIcacls, account = currentAccount()): void {
  let r = icacls([p, '/setintegritylevel', label]);
  if (r.code !== 0 && account && /access is denied/i.test(r.out)) {
    if (icacls([p, '/grant', `${account}:${label.startsWith('(OI)') ? '(OI)(CI)' : ''}F`]).code === 0) r = icacls([p, '/setintegritylevel', label]);
  }
  if (r.code !== 0) throw new Error(`icacls ${label} on ${p}: ${r.out.trim().slice(-300)}`);
}

/** The conversation a claude argv runs and where its files are or go. Undefined when the argv names no safe id. */
export interface OwnFiles {
  sid: string;
  /** `<id>.jsonl`: the one that exists (a resume, from any project folder), else where the CLI makes it (the cwd's folder). */
  file: string;
  /** `<id>\` beside it. */
  dir: string;
  /** The file exists already (a resume). */
  exists: boolean;
}

export function ownFiles(o: { args: string[]; cwd?: string; env: Record<string, string | undefined> }): OwnFiles | undefined {
  const sid = sessionIdOf(o.args);
  const home = o.env.CLAUDE_CONFIG_DIR;
  if (!sid || !home || !path.isAbsolute(home) || !o.cwd) return undefined;
  const projects = path.join(home, 'projects');
  const slug = projectSlug(o.cwd);
  const found = findTranscript(projects, slug, sid);
  const file = found ?? path.join(projects, slug, `${sid}.jsonl`);
  return { sid, file, dir: file.slice(0, -'.jsonl'.length), exists: !!found };
}

/** Processes this host runs per conversation: its files go back to Medium when the last one has exited. */
const live = new Map<string, number>();

/** The top-level `type` of one stream-json line, or undefined when it is not JSON. */
const typeOf = (line: string): string | undefined => {
  try {
    const t = (JSON.parse(line) as { type?: unknown }).type;
    return typeof t === 'string' ? t : undefined;
  } catch {
    return undefined;
  }
};

export interface LabelSpawnerDeps {
  run?: typeof spawn;
  icacls?: IcaclsSync;
  log?: (line: string) => void;
  /** How long a new conversation's first message waits for the CLI's `initialize` answer before the file is made anyway. */
  gateMs?: number;
}

/**
 * Options.spawnClaudeCodeProcess for a Low sandbox agent with transcript labels on: the SDK's claude (the Low copy), its
 * own conversation's files labelled Low around the process, and a new conversation's file made once the CLI is past its
 * start-up check. A label it cannot set is logged; the process still starts (its own writes then fail and say so).
 */
export function lowTranscriptSpawner(d: LabelSpawnerDeps = {}) {
  const run = d.run ?? spawn;
  const icacls = d.icacls ?? realIcacls;
  const log = d.log ?? ((l: string) => console.warn(l));
  const label = (p: string, l: string) => {
    try {
      setLabelSync(p, l, icacls);
      return true;
    } catch (e) {
      log(`transcript labels: ${(e as Error).message}`);
      return false;
    }
  };
  return (o: SpawnOptions): SpawnedProcess => {
    const own = ownFiles(o);
    if (own) {
      fs.mkdirSync(path.dirname(own.file), { recursive: true });
      fs.mkdirSync(own.dir, { recursive: true });
      label(own.dir, DIR_LOW);
      if (own.exists) label(own.file, 'low');
      live.set(own.sid, (live.get(own.sid) ?? 0) + 1);
    }
    const child: ChildProcess = run(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stderr?.resume();
    let released = false;
    const release = () => {
      if (!own || released) return;
      released = true;
      const n = (live.get(own.sid) ?? 1) - 1;
      if (n > 0) return void live.set(own.sid, n);
      live.delete(own.sid);
      if (fs.existsSync(own.file)) label(own.file, 'medium');
      if (fs.existsSync(own.dir)) label(own.dir, DIR_MEDIUM);
    };
    child.on('exit', release);
    child.on('error', release);
    const stdout = new PassThrough();
    child.stdout!.pipe(stdout);
    if (!own || own.exists) return wrap(child, child.stdin!, stdout);

    // A new conversation: the SDK's lines pass until its first that is not a control message; that one and every later one
    // wait for the CLI's first control_response, then the file is made and they go through in order.
    let open = false;
    let held: Buffer[] | undefined;
    let partial = '';
    let seen = '';
    const make = (why: string) => {
      if (open) return;
      open = true;
      clearTimeout(timer);
      try {
        fs.writeFileSync(own.file, '', { flag: 'wx' });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') log(`transcript labels: could not make ${own.file}: ${(e as Error).message}`);
      }
      if (fs.existsSync(own.file) && !label(own.file, 'low')) log(`transcript labels: ${own.file} stays Medium (${why}); this conversation's transcript cannot be written`);
      for (const b of held ?? []) child.stdin!.write(b);
      held = undefined;
      if (ended) child.stdin!.end();
    };
    const timer = setTimeout(() => {
      log(`transcript labels: no initialize answer from claude in ${(d.gateMs ?? 60_000) / 1000}s; made ${own.file} anyway`);
      make('timeout');
    }, d.gateMs ?? 60_000);
    timer.unref?.();
    child.on('exit', () => clearTimeout(timer));
    child.stdout!.on('data', (c: Buffer) => {
      if (open) return;
      seen = (seen + c.toString()).slice(-4096);
      if (seen.split('\n').some((l) => typeOf(l) === 'control_response')) make('initialize answered');
    });
    let ended = false;
    const stdin = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (open) return void child.stdin!.write(chunk, cb);
        if (!held) {
          const text = partial + chunk.toString();
          const lines = text.split('\n');
          partial = lines.pop() ?? '';
          if (lines.every((l) => !l.trim() || typeOf(l)?.startsWith('control_'))) {
            if (lines.length) child.stdin!.write(lines.join('\n') + '\n');
            return cb();
          }
          // From the first other line on, everything waits (the rest of this chunk and the partial tail included).
          const at = lines.findIndex((l) => l.trim() && !typeOf(l)?.startsWith('control_'));
          if (at > 0) child.stdin!.write(lines.slice(0, at).join('\n') + '\n');
          held = [Buffer.from(lines.slice(at).join('\n') + '\n' + partial)];
          partial = '';
          return cb();
        }
        held.push(Buffer.from(chunk));
        cb();
      },
      final(cb) {
        ended = true;
        if (open) child.stdin!.end();
        cb();
      },
    });
    stdin.on('error', () => {});
    child.stdin!.on('error', () => {});
    return wrap(child, stdin, stdout);
  };
}

/** The SpawnedProcess the SDK reads: the child's state and events, with our stdin and stdout in front. */
function wrap(child: ChildProcess, stdin: Writable, stdout: PassThrough): SpawnedProcess {
  return {
    stdin,
    stdout,
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    get pid() {
      return child.pid;
    },
    kill: (s: NodeJS.Signals) => child.kill(s),
    on: (e: 'exit' | 'error', l: (...a: any[]) => void) => void child.on(e, l),
    once: (e: 'exit' | 'error', l: (...a: any[]) => void) => void child.once(e, l),
    off: (e: 'exit' | 'error', l: (...a: any[]) => void) => void child.off(e, l),
  } as unknown as SpawnedProcess;
}

/**
 * The daemon's step (once, when the fence and the switch are on): pins the transcripts and conversation folders written in
 * the last `recentMs` Low (a conversation running when the switch went on keeps appending; agents outlive the daemon,
 * machine/agentHost.ts), then labels `projects` Medium, which every project folder and every other transcript inherits.
 * Answers false, with the reason said, when the label could not be set. Never throws.
 */
export async function lockTranscripts(projects: string, exec: Exec, say: (line: string) => void, o: { now?: number; recentMs?: number; icacls?: IcaclsSync } = {}): Promise<boolean> {
  try {
    fs.mkdirSync(projects, { recursive: true });
    const now = await exec('icacls', [projects], { timeoutMs: 60_000 });
    if (now.code === 0 && explicitMedium(now.stdout)) return true;
    const since = (o.now ?? Date.now()) - (o.recentMs ?? 3 * 24 * 3600_000);
    let pinned = 0;
    for (const slug of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!slug.isDirectory()) continue;
      const folder = path.join(projects, slug.name);
      for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
        const p = path.join(folder, e.name);
        const isConversation = e.isFile() ? e.name.endsWith('.jsonl') : e.isDirectory() && e.name !== 'memory';
        if (!isConversation || fs.statSync(p).mtimeMs < since) continue;
        setLabelSync(p, e.isDirectory() ? DIR_LOW : 'low', o.icacls);
        pinned++;
      }
    }
    setLabelSync(projects, DIR_MEDIUM, o.icacls);
    say(`transcript labels: labelled ${projects} Medium (w5703); ${pinned} transcript${pinned === 1 ? '' : 's'} and folders written in the last ${Math.round((o.recentMs ?? 3 * 24 * 3600_000) / 3600_000)} h kept Low until their conversation's next process ends`);
    return true;
  } catch (e) {
    say(`transcript labels: could not label ${projects} Medium: ${(e as Error).message}; workers can still write every transcript there (the seal still refuses an edited one at resume)`);
    return false;
  }
}

/**
 * The way back (switch off, or the fence off): `projects` and everything in it Low again, explicitly, so every worker's
 * claude can write its transcript wherever an earlier lock left a Medium label. Runs only where `projects` carries the
 * explicit Medium label lockTranscripts set. Never throws.
 */
export async function unlockTranscripts(projects: string, exec: Exec, say: (line: string) => void, icacls?: IcaclsSync): Promise<void> {
  try {
    if (!fs.existsSync(projects)) return;
    const now = await exec('icacls', [projects], { timeoutMs: 60_000 });
    if (now.code !== 0 || !explicitMedium(now.stdout)) return;
    setLabelSync(projects, DIR_LOW, icacls);
    let n = 0;
    for (const slug of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!slug.isDirectory()) continue;
      const folder = path.join(projects, slug.name);
      setLabelSync(folder, DIR_LOW, icacls);
      for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
        setLabelSync(path.join(folder, e.name), e.isDirectory() ? DIR_LOW : 'low', icacls);
        n++;
      }
    }
    say(`transcript labels: off; labelled ${projects} and its ${n} transcripts and folders Low again (w5703)`);
  } catch (e) {
    say(`transcript labels: could not label ${projects} Low again: ${(e as Error).message}`);
  }
}

/** Whether icacls shows the object's own (not inherited) label as Medium. Exported for tests. */
export const explicitMedium = (icaclsOut: string) => /Mandatory Label\\Medium Mandatory Level:(?!\(I\))/i.test(icaclsOut);

/**
 * The daemon's check after the lock: a Low process (`lowNode`, a Low-labelled copy of node) tries to make a file in
 * `projects` and in a project folder, and to append to an existing transcript there. Answers what it met, one line.
 */
export function probeTranscriptLock(lowNode: string, projects: string, runSync = execFileSync): string {
  const script = [
    "const fs=require('fs'),path=require('path');const p=process.argv[1];const out=[];",
    "const tryIt=(what,f)=>{try{f();out.push(what+' WRITTEN')}catch(e){out.push(what+' refused ('+e.code+')')}};",
    "const probe=path.join(p,'ff-lock-probe-'+process.pid+'.jsonl');tryIt('plant in projects',()=>fs.writeFileSync(probe,''));try{fs.unlinkSync(probe)}catch{}",
    "const slugs=fs.readdirSync(p,{withFileTypes:true}).filter(d=>d.isDirectory());",
    "for(const s of slugs){const f=fs.readdirSync(path.join(p,s.name)).find(n=>n.endsWith('.jsonl'));if(!f)continue;",
    "const sp=path.join(p,s.name,'ff-lock-probe-'+process.pid+'.jsonl');tryIt('plant in a project folder',()=>fs.writeFileSync(sp,''));try{fs.unlinkSync(sp)}catch{}",
    "break}",
    'console.log(out.join("; "))',
  ].join('');
  try {
    return String(runSync(lowNode, ['-e', script, projects], { encoding: 'utf8', timeout: 60_000, windowsHide: true })).trim();
  } catch (e) {
    return `probe failed: ${(e as Error).message.slice(0, 200)}`;
  }
}
