# Talk to your orchestrator from Claude Code / Desktop

Chat with your own orchestrator (the one in your chat on the web app's main page) from Claude Code or the Claude Desktop
app, over the portal's `/mcp` endpoint (w1021, asked by Ben). It is the same conversation, history and memory as the web
app, which keeps working as it was: what you send from here shows in the web chat with a small "via Claude Code or Desktop
(your-key)" tag under it, and the orchestrator's replies show in both places.

Tailnet only. `https://fff.tailedfcad.ts.net/mcp` is the address on the tailnet; the whole `/mcp` endpoint, every tool and
the upload, refuses a request that came in through Tailscale Funnel (w1865, see [Safety](#safety)). The claude.ai web and phone apps cannot reach a tailnet address and are
not covered.

## Setup

**1. A key for you, on the portal host** (once per Mac; the key is shown once, and `--user` must be your login, which is
what makes the tools yours):

```
node server/apikey.ts ben-m5 --user ben      # prints ffsb_…; --revoke ben-m5 kills it
```

The key's name labels your messages in the web chat ("via Claude Code or Desktop (ben-m5)"). A key made without `--user`
acts for the owner in the older tools and is refused by these.

A member login's key (a throwaway login for a check, say) can go straight from the portal VM into a 0600 file on the Mac,
never printed: the orchestration worker's `fffctl apikey issue <key name> --user <login> [--create-member] --machine m3
--path .ff-factory/<key name>.key`, and `fffctl apikey revoke <key name>` after (w1415,
[ops-worker.md](ops-worker.md#api-keys-for-a-member-login-w1415)).
**2. Claude Code** (one line, on the Mac; `-s user` makes it available in every project):

```
claude mcp add --transport http -s user ff-factory https://fff.tailedfcad.ts.net/mcp --header "Authorization: Bearer <YOUR-KEY>"
```

Then, in any session: "ask my orchestrator how the w1021 work is going" (Claude calls `orchestrator_send`).

**3. Claude Desktop.** Desktop's config file runs local programs only; `mcp-remote` is the bridge to an HTTP endpoint that needs
a header. Add this to `claude_desktop_config.json` (Settings > Developer > Edit Config), then quit and reopen Desktop. It
needs Node 18 or newer on that Mac:

```json
{ "mcpServers": { "ff-factory": { "command": "npx", "args": ["-y", "mcp-remote", "https://fff.tailedfcad.ts.net/mcp", "--transport", "http-only", "--header", "Authorization:${FF_AUTH}"], "env": { "FF_AUTH": "Bearer <YOUR-KEY>" } } } }
```

The header value sits in `env` with no space after `Authorization:` because Claude Desktop on Windows mangles a space inside
`args` ([mcp-remote README](https://github.com/geelen/mcp-remote)). Desktop's "Add custom connector" goes through
Anthropic's cloud and cannot reach the tailnet, so it is not an option here.

The same key also gives the other `/mcp` tools (sandboxes, agents, branches; README, "Driving it from Claude Code"), so keep
it like a password and revoke it if a Mac is lost.

## The tools

| tool | does |
|---|---|
| `orchestrator_send(text, attachments?, wait_seconds?)` | Sends `text` as your own message and returns the orchestrator's reply (Markdown) when its turn ends. After `wait_seconds` (default 50, at most 600) it returns what it said so far, `[still working …]` and a cursor; the rest lands in the web chat too. |
| `orchestrator_inbox(since?, wait_seconds?)` | What the orchestrator said that you have not read: replies after a timeout, and what it sent on its own (dispatches, worker updates, heartbeats, a permission waiting for you in the web app). Without `since` it goes on from where this key last read (in memory: after a portal restart it starts from the last 15 messages); with `since` (a cursor an earlier call printed) from there. `wait_seconds` waits for something new and for a running turn to end. |
| `orchestrator_attach(name, text \| data_base64)` | Stores a small file (at most 5 MB) and returns its `att_…` id for `orchestrator_send`'s `attachments`. |
| `PUT /mcp/upload?name=<file>` | Any size up to the attachments limit (`attachments.maxMB`, default 200 MB), same key: `curl -T save.zip -H "Authorization: Bearer <YOUR-KEY>" "https://fff.tailedfcad.ts.net/mcp/upload?name=save.zip"` answers `{"id":"att_…"}`. Tell Claude the id. |
| `ask_orchestrator`, `orchestrator_transcript` | The older pair: send and wait (default 180 s), and a condensed transcript. Unchanged (Funnel is refused for every `/mcp` tool). |

## What counts as what

- **Your own turn.** The message is delivered the way the web app's message route delivers one: the orchestrator's `wake_me`
  check-in is cancelled, its filing and follow-up budgets start again, calls a gate held earlier are offered back, and then
  `sendWithAttachments(…, 'human', { requestedBy: you })` (`server/remoteChat.ts`, `RemoteChat.send`). So approvals,
  closes, memory writes and `main_clone` grants work exactly as when you type them in the web chat, and no gate
  was loosened: they still read `turnFrom === 'human'` (`SessionHandle.turnFrom`).
- **Only yours.** No tool takes a person, session or orchestrator name. The orchestrator is `personalFor(<the key's login>)`;
  a key cannot reach another person's orchestrator, the dispatcher or the orchestration worker.
- **Queueing.** The message goes into the same input queue as a web message. If the orchestrator is mid-turn it waits behind
  it (the reply says so) and the reply you get is the turn that answers your message (the result that lists its uuid in
  `answers`), not the earlier turn's text.
- **Images and videos.** A reply that shows a picture or clip from the host (`![shot](/Users/…/belt.png)`, or a bare path)
  comes back with `https://fff…ts.net/api/image?session=…&path=…` links; a browser signed in to FF Factory on the tailnet opens
  them. They are not readable with the key (the page's login is a cookie).
- **A long wait.** A call that waits is answered as an event stream with progress notices every 10 s, which keeps a client's
  own call timeout from running out (the SDK's `resetTimeoutOnProgress`); one that does not honour them may give up after
  about a minute (a guess for Claude Desktop), so pass a shorter `wait_seconds` there and use `orchestrator_inbox` after.

## Safety

- **Funnel.** The portal is also reachable from the internet through Tailscale Funnel (`deploy/vm/RUNBOOK.md`). Tailscale Serve
  adds `Tailscale-Funnel-Request: ?1` to every request that came through Funnel and deletes one a client sent itself
  (`tailscale/ipn/ipnlocal/serve.go`, `addTailscaleIdentityHeaders`, read 2026-10-11); `tailnetOnly` in `server/remoteChat.ts`
  refuses on that header, and also on a forwarded client address (read only from the local proxy's connection) that is not a
  Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48). Since w1865 (asked by Lothsahn: "Please lockdown the older mcp
  tools on the tailnet") `routeMcp` in `server/mcp.ts` makes that check first, for `/mcp` and `/mcp/upload` alike, before the
  key is read: every tool, the older ones (sandboxes, agents, branches) and any added later, answers 403 `refused: this request
  came in through Tailscale Funnel …; /mcp is tailnet-only` from outside. The chat tools keep their own check behind it. No new
  route is exposed: `/mcp/upload` is behind the same checks.
- **Keys.** 256 random bits, stored as a SHA-256, 10 bad keys from one address in 15 minutes answer 429 (`Auth.bearer`). A key
  without a login, or a scoped one (nightly, ffbox), cannot use the chat tools.
- **No key in a log.** Nothing here prints a key or a header; the only log line is `bad API key from <address>` (`Auth.bearer`).

## Tests

`server/remoteChat.test.ts`: a real MCP client over HTTP through `routeMcp` (the server's own `/mcp` routing) against a real
`Agents` with the scripted fake SDK: send and reply, the timeout and the inbox, the person's turn, wrong and unbound and
scoped keys, one person's key never reaching another's orchestrator, Funnel and non-tailnet addresses refused at the endpoint
for an older tool and a chat tool (and both working from a tailnet address), queueing behind a busy turn, uploads,
progress notices, link rendering.

**Checking it live (w1865).** A `Tailscale-Funnel-Request` header you send yourself from a tailnet machine proves nothing:
Serve deletes it, so the request reaches the key check (401 without a key) exactly as a plain tailnet one does. To send a
real Funnel request from a tailnet machine, resolve the name through public DNS and pin it:
`curl --resolve fff.tailedfcad.ts.net:443:$(dig +short @1.1.1.1 fff.tailedfcad.ts.net A | tail -1) https://fff.tailedfcad.ts.net/mcp -d '{}'`
answers 403 `refused: this request came in through Tailscale Funnel …; /mcp is tailnet-only` with or without a key (measured
2026-10-23 on m3 after the b9c0c09 deploy; 401 `API key required` before it).
