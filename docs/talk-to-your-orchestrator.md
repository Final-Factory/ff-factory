# Talk to your orchestrator from Claude Code / Desktop

Chat with your own orchestrator (the one in your chat on the web app's main page) from Claude Code or the Claude Desktop
app, over the portal's `/mcp` endpoint (w1021, asked by Ben). It is the same conversation, history and memory as the web
app, which keeps working as it was: what you send from here shows in the web chat with a small "via Claude Code or Desktop
(your-key)" tag under it, and the orchestrator's replies show in both places.

Tailnet only. `https://fff.tailedfcad.ts.net/mcp` is the address on the tailnet; the chat tools refuse a request that came in
through Tailscale Funnel (see [Safety](#safety)). The claude.ai web and phone apps cannot reach a tailnet address and are
not covered.

## Setup

**1. A key for you, on the portal host** (once per Mac; the key is shown once, and `--user` must be your login, which is
what makes the tools yours):

```
node server/apikey.ts ben-m5 --user ben      # prints ffsb_…; --revoke ben-m5 kills it
```

The key's name labels your messages in the web chat ("via Claude Code or Desktop (ben-m5)"). A key made without `--user`
acts for the owner in the older tools and is refused by these.

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
| `ask_orchestrator`, `orchestrator_transcript` | The older pair: send and wait (default 180 s), and a condensed transcript. Unchanged except that they also refuse Funnel. |

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
  Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48). The refusal covers the four orchestrator tools and the upload; the
  other `/mcp` tools are as before. No new route is exposed: `/mcp/upload` is behind the same key check.
- **Keys.** 256 random bits, stored as a SHA-256, 10 bad keys from one address in 15 minutes answer 429 (`Auth.bearer`). A key
  without a login, or a scoped one (nightly, ffbox), cannot use the chat tools.
- **No key in a log.** Nothing here prints a key or a header; the only log line is `bad API key from <address>` (`Auth.bearer`).

## Tests

`server/remoteChat.test.ts`: a real MCP client over HTTP through `routeMcp` (the server's own `/mcp` routing) against a real
`Agents` with the scripted fake SDK: send and reply, the timeout and the inbox, the person's turn, wrong and unbound and
scoped keys, one person's key never reaching another's orchestrator, Funnel refused, queueing behind a busy turn, uploads,
progress notices, link rendering.
