import { SHELL_PAYLOAD_FLAGS, statements, SUBSTITUTION, unquote, verbOf, words } from './rootFence.ts';

/**
 * The wait guard of a worker's shell (w2015, lothsahn, from w2008's spend report, idea #5, brief B: "stop workers wasting
 * calls on waits that never work"). In 5 days on beast workers made 56 `gh pr checks` calls, which always fail under the
 * fine-grained vault token ("Resource not accessible by personal access token"), and about 110 pure timed sleep loops
 * (`until [ $SECONDS -ge $t ]; do sleep 30; done`); CI polling was 7% of their calls (measured, w2008). Both are refused:
 *
 * - checkChecksRead: `gh pr checks`, and any gh call naming `statusCheckRollup` (`gh pr view --json statusCheckRollup`).
 * - checkTimedSleep: a Bash or PowerShell command whose only work is waiting on the clock (sleep / Start-Sleep, a loop whose
 *   test reads only the clock: $SECONDS, `date +%s`, Get-Date, `true`, a counted `for`), when it can last over 180 s. It can
 *   only when the call may run that long: run_in_background, or a `timeout` over 180000 ms (the Bash tool's default is
 *   120000), and the command's own numbers do not cap it at 180 s. A loop that tests anything else (`until gh run view ...`,
 *   `until [ -f out.log ]`) or a sleep beside real work (a build retry) does real work and passes.
 *
 * Like the rest of the guard it is a SEATBELT: a script file that sleeps is the instructions' job (the brief's "Waiting on CI"
 * and "Coming back later").
 */

const CHECKS_REFUSAL =
  'Refused: a fine-grained token cannot read checks: use ff-pr status, or blocked_on ci:<repo>#<n> (w2015). `gh pr checks` and ' +
  '`--json statusCheckRollup` always answer "Resource not accessible by personal access token" under a vault token; ' +
  '`gh run list --commit <sha>` and `gh run view <id>` read CI runs.';

const SLEEP_REFUSAL =
  'Refused: use wake_me, or blocked_on for CI (w2015). This command only waits on the clock for over 180 s, which holds your ' +
  'sandbox and re-reads your whole context for nothing: `mcp__machine__wake_me` brings you back after a time, ' +
  '`mcp__machine__blocked_on` with prs ["ci:<repo>#<n>"] after CI finishes (ff-pr push prints them), and a loop that tests ' +
  'what you wait for (`until <done>; do sleep 20; done`) is allowed.';

const LIMIT_S = 180;

/** Each simple command of a line, through `bash -c` / `powershell -Command`, with its program and words. */
function simpleCommands(cmd: string): { verb: string; args: string[]; raw: string }[] {
  const out: { verb: string; args: string[]; raw: string }[] = [];
  const run = (command: string) => {
    for (const stages of statements(command)) {
      for (const stage of stages) {
        const w = words(stage);
        let i = 0;
        while (i < w.length && ['&', '.', 'sudo', 'exec', 'nohup', 'time', 'env', 'command'].includes(unquote(w[i]).toLowerCase())) i++;
        const verb = w[i] ? verbOf(w[i]) : '';
        const args = w.slice(i + 1);
        const payload = args.findIndex((a, k) => SHELL_PAYLOAD_FLAGS.has(unquote(a).toLowerCase()) && k + 1 < args.length);
        if (payload >= 0 && /^(?:bash|sh|zsh|dash|cmd|powershell|pwsh)$/.test(verb)) {
          run(unquote(args.slice(payload + 1).join(' ')).replace(/\\\$/g, '$'));
          continue;
        }
        out.push({ verb, args: args.map(unquote), raw: stage });
      }
    }
  };
  run(cmd);
  return out;
}

/** The reason a shell command reads CI checks the vault token cannot read, or undefined. Exported for tests. */
export function checkChecksRead(cmd: string): string | undefined {
  for (const c of simpleCommands(cmd)) {
    if (c.verb !== 'gh') continue;
    const a = c.args.filter((x, k) => !/^(?:--repo|-R)(?:=|$)/.test(x) && !/^(?:--repo|-R)$/.test(c.args[k - 1] ?? ''));
    if (a[0] === 'pr' && a[1] === 'checks') return CHECKS_REFUSAL;
    if (c.args.some((x) => /statusCheckRollup/i.test(x))) return CHECKS_REFUSAL;
  }
  return undefined;
}

/** Seconds of a sleep's argument (`30`, `30s`, `5m`, `1h`), or undefined. */
function seconds(x: string | undefined): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([smh]?)$/.exec(x ?? '');
  if (!m) return undefined;
  return Number(m[1]) * (m[2] === 'm' ? 60 : m[2] === 'h' ? 3600 : 1);
}

/** A clock test: every word is the clock, a number, a variable, an operator or a bracket. */
const CLOCK = /^(?:\$\{?SECONDS\}?|\$\(\(.*\)\)|SECONDS|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\d+|-(?:lt|le|gt|ge|eq|ne)|[<>]=?|==|!=|\[\[?|\]\]?|\(\(|\)\)|!)$/;

/**
 * The reason a shell command only waits on the clock for over 180 s, or undefined. `opts`: the tool call's own limits
 * (the Bash tool's `timeout` in ms, `run_in_background`). Exported for tests.
 */
export function checkTimedSleep(cmd: string, opts: { timeoutMs?: number; background?: boolean } = {}): string | undefined {
  // The call's own ceiling: a foreground call ends at its timeout (Bash's default 120000 ms).
  const ceiling = opts.background ? Infinity : (opts.timeoutMs ?? 120_000) / 1000;
  if (ceiling <= LIMIT_S) return undefined;
  // Arithmetic is one word to the shell: `$(( $(date +%s) + 540 ))` → `$(($(date+%s)+540))`.
  cmd = cmd.replace(/\$\(\((?:[^()]|\([^()]*\))*\)\)/g, (m) => m.replace(/\s+/g, ''));
  // A command substitution other than the clock (`$(date +%s)`, `$(seq 1 20)`) is real work; `$((...))` is arithmetic.
  const subs = cmd.match(SUBSTITUTION) ?? [];
  if (subs.some((s) => !/^(?:\$\(|`)\s*(?:date\s*\+%s|seq(?:\s+\d+){1,3})\s*(?:\)|`)$/.test(s))) return undefined;
  let sleeps = 0;
  let longest = 0;
  let loop = false;
  let counted: number | undefined; // a `for` over N items
  let unbounded = false;
  let deadline: number | undefined; // t=$((SECONDS+N)) / end=$(( $(date +%s) + N ))
  for (const c of simpleCommands(cmd)) {
    let { verb, args } = c;
    // Shell keywords before the command: until/while/do/then/else/{ ... and the PowerShell loop's braces.
    let w = [verb, ...args];
    while (w.length && /^(?:until|while|do|then|else|elif|if|\{|\}|done|fi|end|not)$/i.test(w[0])) {
      if (/^(?:until|while)$/i.test(w[0])) loop = true;
      w = w.slice(1);
    }
    if (!w.length) continue;
    verb = verbOf(w[0]);
    args = w.slice(1);
    const raw = w.join(' ');
    // Assignments: a deadline, or a counter.
    if (w.every((x) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(x))) {
      for (const x of w) {
        const n = /SECONDS\s*\+\s*(\d+)|date\s*\+%s\s*\)\s*\+\s*(\d+)|\+\s*(\d+)\s*\)\)$/.exec(x);
        if (n) deadline = Number(n[1] ?? n[2] ?? n[3]);
        else if (!/^[A-Za-z_][A-Za-z0-9_]*=(?:\d+|\$\(\(.*\)\)|"?\$\(\s*date \+%s\s*\)"?)$/.test(x)) return undefined;
      }
      continue;
    }
    if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(w[0]) && w[1] === '=') {
      // PowerShell: $end = (Get-Date).AddSeconds(600)
      const n = /AddSeconds\((\d+)\)|AddMinutes\((\d+)\)/i.exec(raw);
      if (!n && !/Get-Date/i.test(raw)) return undefined;
      if (n) deadline = n[1] ? Number(n[1]) : Number(n[2]) * 60;
      continue;
    }
    if (verb === 'sleep' || verb === 'start-sleep') {
      const v = args.filter((x) => !/^-(?:s|seconds)$/i.test(x));
      let s = verb === 'start-sleep' && args.some((x) => /^-(?:m|milliseconds)$/i.test(x)) ? (seconds(v[0]) ?? 0) / 1000 : seconds(v[0]);
      if (verb === 'start-sleep' && /^-(?:minutes)$/i.test(args[0] ?? '')) s = (seconds(v[0]) ?? 0) * 60;
      if (s === undefined) return undefined;
      sleeps++;
      longest += s;
      continue;
    }
    if (verb === 'for') {
      // for i in $(seq 1 20) / {1..20} / 1 2 3; for ((i=0;i<20;i++))
      loop = true;
      const brace = /\{(\d+)\.\.(\d+)\}/.exec(raw);
      const seq = /seq\s+(?:(\d+)\s+)?(\d+)\s*[)`]/.exec(raw);
      if (brace) counted = Math.abs(Number(brace[2]) - Number(brace[1])) + 1;
      else if (seq) counted = Number(seq[2]) - Number(seq[1] ?? 1) + 1;
      else if (args[1] === 'in' && args.length > 2 && args.slice(2).every((x) => /^\d+$/.test(x))) counted = args.length - 2;
      else return undefined; // a for over files or anything else: real work
      continue;
    }
    if (verb === 'echo' || verb === 'printf' || verb === ':' || verb === 'true' || verb === 'write-host' || verb === 'write-output') {
      if (verb === 'true' || verb === ':') unbounded = true;
      continue;
    }
    // A clock test: [ $SECONDS -ge $t ], [[ $(date +%s) -lt $end ]], (( SECONDS < t )), ((Get-Date) -lt $end)
    if (verb === '[' || verb === '[[' || verb === 'test' || raw.startsWith('((') || raw.startsWith('(')) {
      const parts = raw.replace(/[()]/g, ' ( ').split(/\s+/).filter(Boolean).filter((x) => x !== '(' && x !== ')');
      const clocky = /SECONDS|get-date|date/i.test(raw);
      if (clocky && parts.every((x) => CLOCK.test(x) || /^(?:get-date|date|\+%s|\$)$/i.test(x) || /^-(?:lt|le|gt|ge)$/i.test(x) || /^\$[A-Za-z_]\w*$/.test(x) || x === 'test')) continue;
      return undefined;
    }
    return undefined; // anything else is real work
  }
  if (!sleeps) return undefined;
  // How long it can wait, from its own numbers.
  let worst: number;
  if (!loop && counted === undefined) worst = longest;
  else if (counted !== undefined && !unbounded) worst = counted * longest;
  else if (deadline !== undefined && !unbounded) worst = deadline + longest;
  else worst = Infinity;
  return Math.min(worst, ceiling) > LIMIT_S ? SLEEP_REFUSAL : undefined;
}
