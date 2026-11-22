import { readOnlyShell } from './readOnlyShell.ts';
import { DANGEROUS_REMOVAL, tempDeletesWithin, tempOnlyDelete, type TempDeleteContext } from './tempDelete.ts';

/**
 * Which of Claude Code's questions a worker's session answers itself instead of asking a person (server/sessions.ts
 * askPermission). Workers run in bypass mode, where Claude Code asks only when one of its own checks trips or cannot run;
 * our guards (server/guard.ts, the main-clone, secret and C: seatbelts) are PreToolUse hooks that already ran and refused
 * what they refuse. w5148 (lothsahn, 2026-11-22: "I just got a bash request. Figure out why I get those and how to cut them
 * down 90%") counted 21 such questions from 10-23 to 11-22, all Bash, and the routes below answer the ones that only read,
 * or delete only inside the session's own temp folder or sandbox. Replay: server/selfAnswer.test.ts.
 *
 * - `temp-delete` (w913): the whole command is a plain delete inside the temp folder, in any mode.
 * - `temp-deletes-within` (w1097, w4338, w5148): bypass mode, Claude Code's dangerous-rm check asked, and every delete in
 *   the command is one of those (or inside the sandbox, after its own `cd`).
 * - `read-only` (w5148): bypass mode, Claude Code's check did not finish (it could not parse the command) or its rm check
 *   fired, and the command only reads (server/readOnlyShell.ts).
 * - `refuse-unparsed` (w5148): bypass mode, Claude Code's check did not finish, and its quotes or substitutions do not
 *   close, so bash would not run it either (w4540's `grep "\$(\|x"` opened a `$(` that never closed; its worker waited
 *   4.7 hours on a person for a command that could only fail). The session refuses it with `deny`, the strictest answer.
 */
export interface SelfAnswerInput {
  toolName: string;
  input: Record<string, unknown>;
  /** Claude Code's reason for asking (decisionReason). */
  why?: string;
  permissionMode?: string;
  /** The session's TMPDIR. */
  tempDir?: string;
  /** The session's working folder (its sandbox for a worker). */
  cwd?: string;
  /** Injected for tests. */
  real?: TempDeleteContext['real'];
  read?: TempDeleteContext['read'];
}

export type SelfAnswer =
  | { ok: true; route: 'temp-delete' | 'temp-deletes-within' | 'read-only' }
  /** Refused without asking anybody: `deny` is what the worker reads. */
  | { ok: true; route: 'refuse-unparsed'; deny: string }
  | { ok: false; why: string };

/** What the lexer says when a quote, `$(`, backquote or brace never closes. */
const UNCLOSED = /^an unbalanced (?:back)?quote$|^a substitution with no end$|^a \$\{ with no end$/;

/** Claude Code's reason when its permission check threw before its safety checks ran (it could not parse the command). */
export const CHECK_UNFINISHED = /did not\s+finish|could not be (?:parsed|analy[sz]ed)|cannot be statically (?:analy[sz]ed|determined)/i;

/**
 * What a read the session answers may never name, even though server/guard.ts and its seatbelts refuse those reads first:
 * secrets and credentials (cicd/credentials.txt, the vault, keys, tokens), a machine's main clone (`<install>/repo`), the C:
 * drive and the daemon's folder.
 */
export const PROTECTED_READ =
  /credential|secret|vault|token|passw|\.ssh\b|\.aws\b|\.gnupg|\.netrc|\.env\b|\.pem\b|\.key\b|id_rsa|id_ed25519|gh-app|daemon\.json|[\\/]ffw[\\/]repo(?:[\\/]|\b)|[\\/]ffw[\\/]daemon\b|(?:^|[\s"'=(])(?:[cC]:|\/c\/|\/mnt\/c\/|\/cygdrive\/c\/)|netsh|firewall|reg(?:\.exe)?\s+(?:add|delete)/i;

export function selfAnswer(a: SelfAnswerInput): SelfAnswer {
  const cmd = a.input.command;
  if ((a.toolName !== 'Bash' && a.toolName !== 'PowerShell') || typeof cmd !== 'string') return { ok: false, why: 'not a shell command' };
  // The last part of either spelling (a Windows path read on Linux too, as the tests do).
  if (!a.tempDir || !/^ffa-/i.test(a.tempDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '')) return { ok: false, why: 'no temp folder of its own' };
  const ctx: TempDeleteContext = { tmp: a.tempDir, ...(a.real ? { real: a.real } : {}), ...(a.read ? { read: a.read } : {}) };
  if (tempOnlyDelete(cmd, ctx).ok) return { ok: true, route: 'temp-delete' };
  if (a.permissionMode !== 'bypassPermissions' || !a.why) return { ok: false, why: 'not bypass mode, or no reason' };
  const sandbox = a.cwd && /[\\/]sandboxes[\\/][^\\/]+[\\/]?$/i.test(a.cwd) ? a.cwd : undefined;
  if (DANGEROUS_REMOVAL.test(a.why)) {
    const r = tempDeletesWithin(cmd, { ...ctx, ...(sandbox ? { sandbox } : {}) });
    if (r.ok) return { ok: true, route: 'temp-deletes-within' };
  }
  if (a.toolName === 'Bash' && (DANGEROUS_REMOVAL.test(a.why) || CHECK_UNFINISHED.test(a.why))) {
    // Our hooks refuse these before Claude Code asks; a read that names one is still never answered here.
    if (PROTECTED_READ.test(cmd)) return { ok: false, why: 'it names a secret, a main clone, C: or the daemon folder' };
    const r = readOnlyShell(cmd, { tmp: a.tempDir });
    if (r.ok) return { ok: true, route: 'read-only' };
    if (CHECK_UNFINISHED.test(a.why) && UNCLOSED.test(r.why))
      return {
        ok: true,
        route: 'refuse-unparsed',
        deny: `Not run: ${r.why}, so bash cannot parse this command either (inside double quotes, \\$( is a backslash and then a command substitution that runs to the next ')'). Search with the Grep tool, or put the pattern in single quotes, or write the script to a file in $TMPDIR and run it.`,
      };
    return { ok: false, why: r.why };
  }
  return { ok: false, why: 'a reason this does not answer' };
}
