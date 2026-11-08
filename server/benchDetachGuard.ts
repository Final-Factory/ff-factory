// w3731: a bench ticket's command started detached outlives the worker's tracked Bash task. lothsahn, about bench locks
// that stayed stuck (w3715): "Make sure that this situation can never happen again… get it fixed." A ticket held by a
// command under nohup, setsid, disown, start /b or a trailing & keeps going after the Bash call returns, so the portal sees
// a worker with no turn and no background task while its ticket holds the lock (server/benchHolders.ts nudges after 2 min
// and revokes 10 min later). The Bash tool's own run_in_background runs the same command as a task the portal tracks and
// ends with the worker. This PreToolUse check refuses the detached forms of a ticket-taking bench command; nohup, setsid
// and & around anything else pass. A seatbelt like timedTicketCommand: a script of the worker's own that detaches inside
// is not seen.
import { timedTicketCommand } from './timedAsk.ts';

const SHELLS = /^(?:bash|sh)(?:\.exe)?$/i;
const base = (w: string) => w.replace(/\\/g, '/').split('/').pop() ?? w;

/** A command's segments at ;, &&, ||, |, & and newlines outside quotes, each with the separator that ended it. */
function segments(cmd: string): { text: string; sep: string }[] {
  const out: { text: string; sep: string }[] = [];
  let cur = '';
  let q: string | undefined;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < cmd.length) {
        cur += c + cmd[++i];
        continue;
      }
      if (c === q) q = undefined;
      cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ';' || c === '\n' || c === '|' || c === '&') {
      // `>&`, `2>&1` and `&>` are redirections, not separators
      if (c === '&' && (cmd[i - 1] === '>' || cmd[i + 1] === '>')) {
        cur += c;
        continue;
      }
      let sep = c;
      if ((c === '|' || c === '&') && cmd[i + 1] === c) sep = c + cmd[++i];
      out.push({ text: cur, sep });
      cur = '';
    } else cur += c;
  }
  out.push({ text: cur, sep: '' });
  return out;
}

const words = (seg: string) => (seg.match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^"([\s\S]*)"$|^'([\s\S]*)'$/, (_m, a, b) => a ?? b));

/** The bench ticket a segment takes, else undefined: what timedTicketCommand sees, and any bench_queue.py timed, run or --acquire. */
function benchTicket(seg: string): string | undefined {
  // Quoted arguments (Start-Process -ArgumentList "...", tmux "...") are read as words of their own.
  const toks = seg.replace(/["'{}()]/g, ' ').split(/\s+/).filter(Boolean);
  const i = toks.findIndex((t) => /^bench_queue\.py$/i.test(base(t)));
  if (i >= 0) {
    const rest = toks.slice(i + 1);
    if (!rest.includes('--release')) {
      if (rest.includes('--acquire')) return 'bench_queue.py --acquire';
      const sub = rest.find((t) => !t.startsWith('-'));
      if (sub === 'timed' || sub === 'run') return `bench_queue.py ${sub}`;
    }
  }
  return timedTicketCommand(toks.join(' '));
}

/** How a segment's command detaches from the shell that runs it, else undefined. */
function detachedBy(seg: string): string | undefined {
  let ws = words(seg.trim().replace(/^\(+\s*/, ''));
  while (ws.length && /^[A-Za-z_]\w*=/.test(ws[0])) ws = ws.slice(1);
  const w = (ws[0] ?? '').toLowerCase();
  if (w === 'nohup') return 'nohup';
  if (w === 'setsid') return 'setsid';
  if (w === 'disown') return 'disown';
  if (w === 'daemonize' || w === 'systemd-run') return w;
  if (w === 'start-process' || w === 'saps') return 'Start-Process';
  if (w === 'start-job' || w === 'sajb') return 'Start-Job';
  if (w === 'screen' && ws.slice(1).some((x) => /^-\w*d/.test(x))) return 'screen -d';
  if (w === 'tmux' && ws.slice(1).includes('-d')) return 'tmux -d';
  if (w === 'start') return 'start /b';
  if ((w === 'cmd' || w === 'cmd.exe') && /^\/[ck]$/i.test(ws[1] ?? '') && (ws[2] ?? '').toLowerCase() === 'start') return 'cmd /c start';
  return undefined;
}

/**
 * The refusal for a shell command that starts a bench ticket's command detached (w3731), else undefined: nohup, setsid,
 * daemonize, Start-Process, Start-Job, start /b, screen -d, tmux -d, a trailing single `&`, or a `disown` anywhere in the
 * command. `bash -c "..."` is read inside.
 */
export function checkDetachedBench(cmd: string, depth = 0): string | undefined {
  const segs = segments(cmd);
  const disown = segs.some((s) => (words(s.text.trim())[0] ?? '') === 'disown');
  for (const s of segs) {
    const ws = words(s.text.trim().replace(/^\(+\s*/, ''));
    const c = ws.indexOf('-c');
    if (SHELLS.test(base(ws[0] ?? '')) && c >= 0 && depth < 3) {
      const inner = checkDetachedBench(ws[c + 1] ?? '', depth + 1);
      if (inner) return inner;
    }
    const takes = benchTicket(s.text);
    if (!takes) continue;
    const how = detachedBy(s.text) ?? (s.sep === '&' ? 'a trailing &' : disown ? 'disown' : undefined);
    if (!how) continue;
    return (
      `w3731: ${takes} takes a bench ticket, and ${how} detaches it from this tool call: it would keep holding the lock after ` +
      'FF Factory stops tracking your work, until the portal revokes it as idle. Run the same command with the Bash tool\'s ' +
      'run_in_background instead (no nohup, setsid, disown, start /b, Start-Process or trailing &): FF Factory then sees it ' +
      'as your background task, wakes you when it ends, and ends it with you.'
    );
  }
  return undefined;
}
