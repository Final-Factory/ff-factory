/**
 * The probe pile-up guard (w6784). A program run with a timeout (a probe: Get-CimInstance, a perf counter, schtasks) is
 * killed when its time runs out. On BEAST on 2026-11-28 from about 07:31Z Windows' WMI hung, and the PowerShells stuck in it
 * did not end at that kill (TerminateProcess leaves a process stuck in the kernel half-exited): about 15 were still there
 * seven hours later, and the daemon's timers kept starting more of the same kind every 30 or 60 s.
 *
 * What it does: every program started with a timeout through execFileOffThread (server/spawnThread.ts, so run() too) or
 * runOffThread (server/hostProbe.ts) is a probe of a kind: its explicit `probe` name, else its program, arguments and folder.
 * When its callback has not come LINGER_MS after its timeout (execFile answers only once the program has really exited, so
 * no answer means it is still there past its kill), it lingers, and the guard says so once. While a probe of a kind
 * lingers, a new one of that kind:
 * - warn (stage 1, lothsahn's lockout rule: warn-only first): is started as before, and the guard says it would not be,
 *   at most once per kind every WARN_EVERY_MS;
 * - enforce: is not started; the caller is answered at once with code -1 and why, and the guard says so the same way.
 *   One retry per kind every RETRY_EVERY_MS while fewer than MAX_LINGERING of it linger, so a probe whose cause cleared
 *   (WMI answering again) runs again by itself while a stuck one cannot pile up past MAX_LINGERING.
 * - off: nothing is tracked.
 * enforce also answers the caller of a probe that lingers, as timed out, at once: execFile answers only once the program has
 * exited, so a caller awaiting one stuck past its kill would wait for good (a timer awaiting it would never run again).
 * A probe's late answer (it did exit after all) ends its lingering.
 */

export type ProbeGuardMode = 'off' | 'warn' | 'enforce';

/** After its timeout, how long a probe may take to be gone before it counts as lingering (the kill, its exit, the pipes). */
export const LINGER_MS = 10_000;
/** The guard's line about one kind, at most this often. */
export const WARN_EVERY_MS = 10 * 60_000;
/** enforce: one new probe of a lingering kind may still start this often (it may answer: the cause can clear). */
export const RETRY_EVERY_MS = 15 * 60_000;
/** enforce: never more than this many of one kind lingering. */
export const MAX_LINGERING = 3;

const parseMode = (v: string | undefined): ProbeGuardMode | undefined => (v === 'off' || v === 'warn' || v === 'enforce' ? v : undefined);

/** The default; FF_PROBE_GUARD (off, warn, enforce) overrides it. */
export const PROBE_GUARD_DEFAULT: ProbeGuardMode = 'warn';

let mode: ProbeGuardMode = parseMode(process.env.FF_PROBE_GUARD) ?? PROBE_GUARD_DEFAULT;
let say: (line: string) => void = (l) => console.warn(l);

/** Set the mode (the daemon, from FF_PROBE_GUARD; tests) and where its lines go. Answers the mode now in force. */
export function useProbeGuard(m?: ProbeGuardMode | string, log?: (line: string) => void): ProbeGuardMode {
  mode = parseMode(m) ?? mode;
  if (log) say = log;
  return mode;
}

export function probeGuardMode(): ProbeGuardMode {
  return mode;
}

interface Running {
  label: string;
  startedAt: number;
  timeoutMs: number;
  pid?: number;
  lingering: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface Kind {
  running: Set<Running>;
  saidAt: number;
  retriedAt: number;
}

const kinds = new Map<string, Kind>();
/** LINGER_MS, shorter in tests. */
let lingerMs = LINGER_MS;

/** A short name for a probe in a log line: the program and the start of its script (an encoded one decoded). */
export function probeLabel(cmd: string, args: string[]): string {
  const prog = cmd.replace(/^.*[\\/]/, '');
  const enc = args.findIndex((a) => /^-(e|ec|encodedcommand)$/i.test(a));
  let text = '';
  if (enc >= 0 && args[enc + 1] && /^(powershell|pwsh)/i.test(prog)) {
    try {
      text = Buffer.from(args[enc + 1], 'base64').toString('utf16le');
    } catch {
      text = '';
    }
  } else {
    const c = args.findIndex((a) => /^-(c|command)$/i.test(a));
    text = c >= 0 ? (args[c + 1] ?? '') : args.join(' ');
  }
  text = text.replace(/\s+/g, ' ').trim();
  return `${prog}${text ? ` "${text.length > 80 ? `${text.slice(0, 80)}...` : text}"` : ''}`;
}

const keyOf = (cmd: string, args: string[], cwd?: string, probe?: string) => (probe ? `probe:${probe}` : `${cmd}\0${args.join('\0')}\0${cwd ?? ''}`);

const iso = (t: number) => new Date(t).toISOString();

/** What a caller does with one probe it was let start. */
export interface ProbeTicket {
  /** Its pid, once known (for the log). */
  pid(pid: number | undefined): void;
  /** Its answer came (it exited, or it could not start). */
  done(): void;
}

const NO_TICKET: ProbeTicket = { pid: () => undefined, done: () => undefined };

/**
 * Before a program with a timeout starts: undefined to start it as before, with a ticket to report its pid and answer; or
 * `refused` (enforce only) with the reason to answer the caller instead of starting it. No timeout: not a probe.
 */
export function probeBegin(o: { cmd: string; args: string[]; cwd?: string; timeoutMs?: number; probe?: string; now?: number; onLinger?: () => void }): { ticket: ProbeTicket; refused?: undefined } | { refused: string; ticket?: undefined } {
  if (mode === 'off' || !o.timeoutMs || o.timeoutMs <= 0) return { ticket: NO_TICKET };
  const now = o.now ?? Date.now();
  const key = keyOf(o.cmd, o.args, o.cwd, o.probe);
  const label = o.probe ?? probeLabel(o.cmd, o.args);
  let kind = kinds.get(key);
  if (!kind) {
    kind = { running: new Set(), saidAt: 0, retriedAt: 0 };
    kinds.set(key, kind);
  }
  const lingering = [...kind.running].filter((r) => r.lingering);
  if (lingering.length) {
    const oldest = lingering.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
    const what = `${lingering.length} earlier ${label} (the oldest${oldest.pid ? ` pid ${oldest.pid},` : ''} started ${iso(oldest.startedAt)}) still running past its ${Math.round(oldest.timeoutMs / 1000)} s timeout's kill`;
    if (mode === 'warn') {
      if (now - kind.saidAt >= WARN_EVERY_MS) {
        kind.saidAt = now;
        say(`probe guard (warn only): ${what}; another of that kind is starting anyway, and would not be under FF_PROBE_GUARD=enforce (w6784)`);
      }
    } else {
      const retry = lingering.length < MAX_LINGERING && now - kind.retriedAt >= RETRY_EVERY_MS;
      if (!retry) {
        const why = `not started: ${what} (w6784's probe guard; one retry every ${RETRY_EVERY_MS / 60_000} min while fewer than ${MAX_LINGERING} linger)`;
        if (now - kind.saidAt >= WARN_EVERY_MS) {
          kind.saidAt = now;
          say(`probe guard: ${why}`);
        }
        return { refused: why };
      }
      kind.retriedAt = now;
      say(`probe guard: ${what}; one more of that kind is let start to see whether it answers now (w6784)`);
    }
  }
  const r: Running = { label, startedAt: now, timeoutMs: o.timeoutMs, lingering: false };
  const k = kind;
  r.timer = setTimeout(() => {
    r.timer = undefined;
    if (!k.running.has(r)) return;
    r.lingering = true;
    // enforce's one retry comes RETRY_EVERY_MS after the last probe of the kind began to linger, not at once.
    k.retriedAt = Date.now();
    say(`probe guard: ${label}${r.pid ? ` (pid ${r.pid})` : ''}, started ${iso(r.startedAt)}, has not ended ${Math.round((o.timeoutMs! + lingerMs) / 1000)} s after its start, though its ${Math.round(o.timeoutMs! / 1000)} s timeout killed it: it lingers${mode === 'enforce' && o.onLinger ? '; its caller is answered as timed out now' : ''} (w6784)`);
    // enforce: the caller is not left waiting on an answer that may never come (execFile answers only once it has exited).
    if (mode === 'enforce') o.onLinger?.();
  }, o.timeoutMs + lingerMs);
  r.timer.unref?.();
  kind.running.add(r);
  return {
    ticket: {
      pid: (pid) => {
        if (pid) r.pid = pid;
      },
      done: () => {
        if (r.timer) clearTimeout(r.timer);
        r.timer = undefined;
        if (!k.running.delete(r)) return;
        if (r.lingering) say(`probe guard: ${label}${r.pid ? ` (pid ${r.pid})` : ''}, started ${iso(r.startedAt)}, has ended after all, ${Math.round((Date.now() - r.startedAt) / 1000)} s after its start (w6784)`);
        if (!k.running.size) kinds.delete(key);
      },
    },
  };
}

/** What lingers now, by label (the daemon's status, tests). */
export function lingeringProbes(): { label: string; pid?: number; startedAt: string; timeoutMs: number }[] {
  return [...kinds.values()].flatMap((k) => [...k.running].filter((r) => r.lingering).map((r) => ({ label: r.label, ...(r.pid ? { pid: r.pid } : {}), startedAt: iso(r.startedAt), timeoutMs: r.timeoutMs })));
}

/** Tests: forget every probe; `linger` sets the time after a timeout before a probe lingers (default LINGER_MS). */
export function resetProbeGuardForTest(linger = LINGER_MS) {
  for (const k of kinds.values()) for (const r of k.running) if (r.timer) clearTimeout(r.timer);
  kinds.clear();
  lingerMs = linger;
}
