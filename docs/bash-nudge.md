# Shell approvals: the nudge, route requests and card clearing (w5914)

lothsahn, 2026-11-26: "Every time a worker needs approval for a bash command, can we send it back a message asking if
there's a non bash way to do it rather than blocking on bash approval?", "Make this part of the FF harness, not just your
rules for yourself", and "When you deny a bash request the harness should remove the card from my panel".

Code: `server/bashNudge.ts` (the rules), `server/sessions.ts` `askPermission` and `denyShellPending` (the session side),
`server/routeRequests.ts` (filing, dedup and landing). Tests: `server/bashNudge.test.ts`, `server/agentSession.test.ts`
(the `w5914` tests), `server/routeRequests.test.ts`.

## What happens to a shell permission question

Every fence (`server/guard.ts`), deny rule and self-answer (`server/selfAnswer.ts`, `server/tempDelete.ts`) runs first,
as before. Nothing here ever allows a command: it only denies, or passes the question on to a person.

1. **The nudge.** A Bash or PowerShell question from any session that is not an orchestrator (every person's workers, the
   standing agents, the ops worker) is answered by FF Factory itself, with no card: a deny whose text starts
   `[FF Factory, w5914: no person was asked yet]` and asks for another route (a dedicated tool, an `mcp__machine__*`
   tool, or a command that needs no approval). Questions for every other tool reach a person as before.
2. **Escalation.** If the worker has no other route, it runs the same command again with its description starting
   `No other route: <reason>` (or says so in its text). Then the normal card goes up, its reason reading "No other route,
   the worker says: … (Claude Code asked because: …)". The transcript event keeps Claude Code's own reason, so the prompt
   count (`fffctl approvals`, w1097) still groups by it.
3. **The loop guard.** One nudge per distinct command (whitespace collapsed), per agent (a subagent has its own), per turn.
   The second ask of the same command in the turn reaches a person, reason or none. A new turn starts the count again.

Every agent with a shell reads the rule up front (`PREFER_TOOLS` in `server/bashNudge.ts`: the sandbox worker's
"Shell steps that never wait for a person", the ops worker's brief, the standing agents' Tools section): prefer the
dedicated tools, avoid commands that need approval, answer a nudge with another route, and say "No other route" only with a
concrete reason. The `final-factory-agents` evidence-gate lesson says the same for every agent.

## Card clearing

A shell card that anything other than a person's click resolves clears at once from the sandbox panel, the request's row
and the Needs you list (all read `pendingPermissions`; `decide` removes it):

- a message from a person or an orchestrator reaches the worker (`MESSAGE_WHILE_WAITING`); a system notice does not;
- the worker's turn ends, or it goes idle, with the command still waiting (`TURN_ENDED_WHILE_WAITING`);
- its route lands (below).

Before this, the card of w5869 stayed up after the worker was told to use Edit instead (card d732483b).

## Route requests

A card that came with "no other route" files a request to build the missing route (`server/routeRequests.ts`):

- **Dedup.** The need is named by `routeKey`: the shell, the program (path and `.exe` dropped) and, for programs with
  sub-commands (git, gh, npm, unity-slot, ff-pr, cargo, python, ...), the first sub-command: `bash:git push`,
  `bash:rm`, `powershell:taskkill`. Workers asking for the same need join the newest request for it as waiters; each
  card is linked in the logs of the route request and of the worker's own open requests.
- **Triage** (`triageRoute`). It **waits for lothsahn's approval** (Intake tab, `approval: pending`, triage
  `needs-human`) when the command or reason touches any of:
  - credentials or secrets (vault, tokens, keys, `.ssh`, `gh auth`, keychain);
  - network or firewall (curl, wget, ssh, scp, netsh, firewall rules, tailscale, ...);
  - a machine-wide change (sudo, registry, services, scheduled tasks, package installs, killing processes, ACLs,
    shutdown, Defender settings);
  - the fences or permission rules (guard, hooks, `.claude/`, settings files, `--no-verify`, bypass modes);
  - an absolute path outside a worker install folder (`ffw`), or its main clone or daemon folder.

  Its brief lists the options with the recommended one marked: a narrow MCP tool first, or "no new route" first when it
  touches credentials or the fences. Anything else **goes ahead with no approval** (`approved`, triage `follow-up`): it
  stays inside ffw and touches none of the above, so the route is a scoped MCP tool or an allow rule inside ffw.
- At most 10 route requests are filed a day (`ROUTE_DAILY_CAP`); beyond that, and while a request for the need closed
  declined or cancelled in the last 30 days, the card goes to a person with a note and nothing new is filed.
- Meanwhile the card stays with a person, linked to the route request.

## When the route lands

The route request's worker ends its DONE with `Route: <what workers use now>`. When the request is done, the portal's
running commit is recorded; once a different commit runs (its pull request merged and deployed), every worker still
waiting on a card for that need is denied with `routeLandedMessage` naming the route, and the card clears. A worker that
asks for the need later is told the route once; asked again, a person answers, since its need may be one the route does not
cover. The check runs at start and every two minutes.
