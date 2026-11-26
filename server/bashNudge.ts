/**
 * w5914 (lothsahn, 2026-11-26: "Every time a worker needs approval for a bash command, can we send it back a message asking
 * if there's a non bash way to do it rather than blocking on bash approval?"): before a person is asked about a worker's
 * shell command, the session answers it once itself, with a deny that asks for another route. The worker either does the
 * same thing another way, or runs the command again saying why it cannot ("No other route: <reason>"), and only then is a
 * person asked, with that reason on the card. A "no other route" files one request to build the missing route
 * (server/routeRequests.ts), triaged here by `triageRoute`. Nothing is ever allowed by this module: it only denies or
 * passes the question on, and every PreToolUse fence (server/guard.ts) and deny rule has already run before it is reached.
 *
 * The rules, in one place (docs/bash-nudge.md):
 * - Who: every session that is not an orchestrator (workers of every person, standing agents, the ops worker).
 * - What: Bash and PowerShell permission questions the session does not answer itself (server/selfAnswer.ts). Every other
 *   tool's question is asked as before.
 * - The loop guard: one nudge per distinct command, per agent (a subagent has its own), per turn. The second ask of the
 *   same command in the turn goes to a person at once, reason or none.
 */

/** Tools whose questions are nudged: the shells. Every other tool is asked as before. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);

/** The first words of a nudge, so a worker (and the fake agent of the tests) can tell it from a person's deny. */
export const NUDGE_MARK = '[FF Factory, w5914: no person was asked yet]';

/** "No other route: <reason>" in the call's description (or the worker's words): the worker's reasoned refusal. */
const NO_ROUTE = /\bno other route\b\s*[:\-–—]?\s*([\s\S]*)$/i;

/** Who is nudged: everything but the orchestrators (they hold no shell work of their own). */
export function nudges(kind: string | undefined, toolName: string): boolean {
  return kind !== 'orchestrator' && SHELL_TOOLS.has(toolName);
}

/** The command text of a shell call, whitespace collapsed: what "the same command" means for the loop guard. */
export function commandOf(input: Record<string, unknown>): string {
  return typeof input.command === 'string' ? input.command.replace(/\s+/g, ' ').trim() : '';
}

/** The loop guard's key: which agent (the main one or a subagent), which shell, which command. */
export function nudgeKey(toolName: string, input: Record<string, unknown>, agentId?: string): string {
  return `${agentId ?? 'main'}\u0000${toolName}\u0000${commandOf(input)}`;
}

/** The deny the worker reads instead of waiting on a person. */
export function nudgeMessage(toolName: string): string {
  return (
    `${NUDGE_MARK} This ${toolName} command needs a person's approval, so it did not run. Do the same thing another way that needs none: ` +
    'a dedicated tool (Read, Grep or Glob to read and search; Edit or Write to change a file), an MCP tool (mcp__machine__* for ' +
    "FF Factory's own steps), or a shell command you are already allowed to run (often the same command without the part " +
    "Claude Code's check flagged: one step per call, a delete with every path written out under $TMPDIR). " +
    'If there is truly no such route, run this exact command again with its description starting "No other route: " and the ' +
    'concrete reason (what you need, and why no tool or allowed command does it). A person is then asked, with your reason ' +
    'beside the command, and FF Factory files a request to build the missing route. Ask once per command: a second ask goes to a person.'
  );
}

/**
 * The worker's reason when it insists: the "No other route: ..." part of the call's description, else of what it said
 * since the nudge; undefined when it gave none (it still reaches a person: the loop guard).
 */
export function noRouteReason(input: Record<string, unknown>, said?: string): string | undefined {
  for (const text of [typeof input.description === 'string' ? input.description : '', said ?? '']) {
    const m = NO_ROUTE.exec(text);
    const why = m?.[1]?.replace(/\s+/g, ' ').trim();
    if (why) return why.slice(0, 500);
  }
  return undefined;
}

/** What a person's card says about a call the worker insisted on. */
export function insistedReason(claude: string | undefined, worker: string | undefined): string {
  const mine = worker ? `No other route, the worker says: ${worker}` : 'The worker ran it again after FF Factory asked for another route, and gave no reason.';
  return claude ? `${mine} (Claude Code asked because: ${claude})` : mine;
}

/** Words that do not name the need: a `cd`, an env assignment, a sudo, a path to the program. */
function words(command: string): string[] {
  const first = command.split(/\n|&&|\|\||;|\|/).map((s) => s.trim()).filter((s) => s && !/^cd\s/.test(s) && !/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(s));
  const out = (first[0] ?? '').split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return out;
}

/**
 * Many workers asking for the same missing route file one request (lothsahn's note 1, point 5): the route is named by its
 * program and first sub-command word ("git push", "taskkill", "rm"), lower case, a path or `.exe` dropped. Two different
 * deletes are one need (a way to delete there); two different programs are two.
 */
export function routeKey(toolName: string, command: string): string {
  const w = words(command);
  const prog = (w[0] ?? '').replace(/^["']|["']$/g, '').split(/[\\/]/).pop()!.replace(/\.exe$/i, '').toLowerCase();
  const sub = w.slice(1).find((x) => !x.startsWith('-') && /^[a-z][a-z0-9-]*$/i.test(x));
  const twoWord = /^(git|gh|npm|npx|unity-slot|ffu-slot|ff-pr|ff-leftovers|docker|cargo|python3?|node|uv)$/;
  return `${toolName.toLowerCase()}:${prog}${sub && twoWord.test(prog) ? ` ${sub.toLowerCase()}` : ''}` || toolName.toLowerCase();
}

export type RouteTriage = { path: 'go'; why: string } | { path: 'approval'; why: string[] };

/** The criteria (docs/bash-nudge.md, "Triage"): any of these needs lothsahn's approval before a route is built. */
export const NEEDS_APPROVAL: readonly { what: string; re: RegExp }[] = [
  { what: 'credentials or secrets', re: /credential|secret|vault|token|passw|\.ssh\b|\bssh-(?:keygen|add)\b|\bgpg\b|\.env\b|\.pem\b|id_rsa|id_ed25519|gh-app|\bgh auth\b|keychain|\bsecurity\s+find/i },
  { what: 'network or firewall', re: /\b(?:netsh|ufw|iptables|nft|pfctl|firewall|New-NetFirewallRule|Set-NetFirewall\w*|tailscale|ssh|scp|sftp|rsync|curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|nc|ncat|socat)\b/i },
  {
    what: 'a machine-wide change',
    re: /\b(?:sudo|runas|reg(?:\.exe)?\s+(?:add|delete|import)|HKLM:|setx|sc(?:\.exe)?\s+(?:create|config|delete|stop|start)|schtasks|systemctl|launchctl|winget|choco|apt(?:-get)?|brew|dnf|yum|pip3?\s+install|npm\s+(?:i|install)\s+(?:-g|--global)|shutdown|Restart-Computer|Stop-Computer|bcdedit|diskpart|mkfs|format\s+[a-z]:|icacls|takeown|chown|Set-ExecutionPolicy|taskkill|Stop-Process|pkill|killall|kill\s+-9|Set-MpPreference|Add-MpPreference|wsl\s+--(?:install|unregister|shutdown))\b/i,
  },
  { what: 'the fences or permission rules', re: /guard|fence|landlock|seatbelt|\.claude[\\/]|settings(?:\.local)?\.json|hooks?[\\/]|permissions?\b|daemon\.json|--no-verify|dangerously|bypassPermissions|allowedTools|disallowedTools/i },
];

/** An absolute path that is not inside a worker install folder (ffw), or is its protected main clone or daemon folder. */
export function outsideFfw(command: string): string | undefined {
  const paths = command.match(/(?:^|[\s"'=(])((?:[A-Za-z]:[\\/]|\/(?:[a-z]\/|mnt\/[a-z]\/|Users\/|home\/|etc\/|usr\/|var\/|opt\/|Library\/|System\/|private\/|tmp\/|root\/)|~[\\/])[^\s"'|;&)]*)/g) ?? [];
  for (const raw of paths) {
    const p = raw.replace(/^[\s"'=(]/, '').replace(/\\/g, '/');
    if (!/\/ffw(?:\/|$)/i.test(p)) return p;
    if (/\/ffw\/(?:repo|daemon)(?:\/|$)/i.test(p)) return p;
  }
  return undefined;
}

/**
 * Triage of a missing route (lothsahn's note 1, point 2): a route that fits Final Factory's design and is low risk goes
 * ahead with no approval (a read-only or scoped MCP tool, an allow rule inside ffw); anything that needs new write scope
 * outside ffw, credentials, network or firewall, a machine-wide change, or touches the fences waits for lothsahn.
 */
export function triageRoute(command: string, reason: string): RouteTriage {
  const why: string[] = [];
  const text = `${command}\n${reason}`;
  for (const c of NEEDS_APPROVAL) if (c.re.test(text)) why.push(c.what);
  const out = outsideFfw(command);
  if (out) why.push(`a path outside the worker install folder (${out.slice(0, 80)})`);
  if (why.length) return { path: 'approval', why };
  return { path: 'go', why: 'it stays inside the worker install folder and touches no credentials, network, machine-wide setting or fence' };
}

/** The options a route request that waits for approval lists, with the recommendation first marked. */
export function routeOptions(t: RouteTriage): string[] {
  const risky = t.path === 'approval' && t.why.some((w) => w === 'credentials or secrets' || w === 'the fences or permission rules');
  const tool = 'A narrow MCP tool (mcp__machine__*) that does exactly this need, with its own checks and arguments (no free-form command).';
  const rule = 'An allow rule for this command shape only, scoped to the worker install folder (ffw).';
  const ask = 'No new route: a person keeps answering this command each time it is asked.';
  return risky ? [`${ask} (recommended: it touches ${t.why.join(' and ')})`, tool, rule] : [`${tool} (recommended)`, rule, ask];
}

export interface RouteNeed {
  key: string;
  toolName: string;
  command: string;
  reason: string;
  worker: string;
  requests: string[];
}

/** The route request's title. */
export function routeTitle(n: Pick<RouteNeed, 'key'>): string {
  return `Route for workers: a way to do "${n.key.replace(/^[a-z]+:/, '')}" without a shell approval (w5914)`;
}

/** The route request's brief: the need, the triage and, when it waits, the options. */
export function routeBrief(n: RouteNeed, t: RouteTriage): string {
  const lines = [
    `Filed by FF Factory itself (w5914): a worker answered the harness's nudge with "no other route" for a ${n.toolName} command that needs a person's approval.`,
    '',
    `Worker: ${n.worker}${n.requests.length ? ` on ${n.requests.join(', ')}` : ''}`,
    `Command: ${n.command.slice(0, 600)}`,
    `The worker's reason: ${n.reason}`,
    `Route key (the dedup key; other workers who ask for the same are added here): ${n.key}`,
    '',
    'Build a narrow route for this need, in Final-Factory/ff-factory (an MCP tool, or an allow rule inside ffw), so workers stop needing a person for it. Keep every fence and deny rule; never widen one to make the command pass.',
    'End your DONE report with one line `Route: <what workers use now, e.g. the tool name and its arguments>`: once the pull request merges and the portal runs it, FF Factory denies every worker still waiting on this approval with that line.',
    '',
  ];
  if (t.path === 'go') lines.push(`Triage: low risk, goes ahead with no approval (${t.why}; docs/bash-nudge.md, "Triage").`);
  else lines.push(`Triage: waits for lothsahn's approval: it needs ${t.why.join('; ')} (docs/bash-nudge.md, "Triage").`, 'Options:', ...routeOptions(t).map((o, i) => `${i + 1}. ${o}`));
  return lines.join('\n');
}

/** The `Route: ...` line of a route request's DONE report, or its title when it gave none. */
export function routeLine(report: string | undefined, fallback: string): string {
  const m = /^\s*Route:\s*(.+)$/im.exec(report ?? '');
  return (m?.[1] ?? fallback).trim().slice(0, 400);
}

/** The deny a waiting worker reads once its route is live (lothsahn's note 1, point 4). */
export function routeLandedMessage(work: string, route: string): string {
  return `[FF Factory, w5914] Not run: the route you were waiting for is live now (${work}, merged and deployed). Use it instead of this command: ${route}. The approval card is cleared.`;
}

/** The deny a worker reads when a message reached it while its shell command waited for a person (lothsahn's 05:24 note). */
export const MESSAGE_WHILE_WAITING =
  '[FF Factory, w5914] Not run: a message reached you while this command waited for a person, so its approval card is cleared. Read the message first. If you still need the command, run it again: a person is then asked.';

/** The deny when the turn ended (or the agent went idle) with the command still waiting. */
export const TURN_ENDED_WHILE_WAITING = '[FF Factory, w5914] Not run: your turn ended while this command waited for a person, so its approval card is cleared.';

/**
 * The rule every agent that has a shell reads up front (lothsahn, w5914: "Make this part of the FF harness, not just your rules
 * for yourself"): the sandbox workers' SHELL_STEPS (agents.ts), the ops worker's brief (opsWorker.ts) and the standing agents'
 * (standing.ts).
 */
export const PREFER_TOOLS =
  "Prefer the dedicated tools to the shell (Read, Grep and Glob to read and search; Edit and Write to change a file; an mcp__machine__* tool for FF Factory's steps), and avoid any command that needs a person's approval. When one does, FF Factory answers it first, before any person is asked: do the same thing another way that needs no approval; only when there is truly none, run the same command again with its description starting \"No other route: \" and the concrete reason. A person is asked then, and FF Factory files a request to build that route; once the harness names the new route, use it (docs/bash-nudge.md).";
