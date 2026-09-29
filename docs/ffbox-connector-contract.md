# FFBox connector contract (provider protocol 1)

What FFBox's connector must do to talk to FF Factory. Written for Lothsahn, who builds the connector in
the ffbox repo. The design and the reasons behind it are in [ffbox-integration.md](ffbox-integration.md).
FF Factory's side is `server/providers.ts`. The schemas are in `server/providerProtocol.ts`, the
source of truth when this page and the code disagree. A working reference client is
`e2e/mockConnector.ts`.

Protocol 1 is **read-only**. The connector reports capacity, conversations and intake reports, and
FF Factory records and shows them. Nothing FF Factory sends asks FFBox to do anything.

The phase 3 work messages are specified below, in [Work messages](#work-messages-phase-3-who-asked-and-who-pays):
`submit`, `diagnose` and `stop`, each naming the person it is for, and the connector's `accepted` and
`refused`. FF Factory does not send them yet, and it never sends one to a connector whose `hello` does not
list it in `accepts`. A connector built to this page as it was before can ignore that section.

## The shape

- The connector **dials out** to `wss://<FF Factory public URL>/provider`, which is the Tailscale Funnel
  URL. FFBox opens no port and does not join the tailnet.
- One connection at a time. A newer connection with the same token replaces the older one (close
  `4000`).
- JSON text frames, one message per frame, at most 64 KB each. Binary frames are ignored.
- The connector is fixed code with no model. It runs as its own unix account and holds only its
  token. It reads FFBox state through `ffwatch` (for example `ffwatch intake-events --since <cursor>
  --json`), never by opening report zips.

## Auth

- The token looks like `ffpv1_` followed by 43 base64url characters (`^ffpv1_[A-Za-z0-9_-]{43}$`).
  Ben mints it on the FF Factory host with `node server/providerToken.ts`, which prints it once. FF
  Factory keeps only its SHA-256, in `config.json` as `providers.ffbox.tokenSha256`. The token
  reaches FFBox out of band and goes into FFBox's secrets file. Keep it out of argv, logs and
  containers, like every other FFBox secret.
- It is sent on the upgrade request as `Authorization: Bearer <token>`.
- FF Factory must also have `providers.ffbox.enabled: true`. The default is off.
- FF Factory redacts anything shaped like a token from transcripts (`ffpv1_[redacted …abcd]`).

The upgrade answers:

| status | meaning | connector does |
|---|---|---|
| `101` | connected | send `hello` within 10 s |
| `401` | no token, a malformed token, or not the configured one | check its secret; retry in 10 minutes |
| `403` | the token is right, but FF Factory has the provider switched off | retry in 5 minutes |
| `429` | 10 failed attempts from this address in 15 minutes | retry in 15 minutes |
| anything else, or no answer (a `502` while FF Factory restarts, a network error) | FF Factory is down or restarting | the normal backoff below |

## Handshake

The connector's first message is `hello`:

```json
{ "type": "hello", "protocol": 1, "provider": "ffbox",
  "connector": { "version": "1.0.0", "commit": "abc1234" },
  "web": "https://ffbox.lan:8787" }
```

| field | rule |
|---|---|
| `protocol` | must be `1`. Any other number closes with `4426` |
| `provider` | `"ffbox"` |
| `connector.version` | 1-40 characters of `A-Z a-z 0-9 . _ + -` |
| `connector.commit` | optional, 7-40 hex characters |
| `web` | optional, an `https://` URL where people read FFBox's own page. FF Factory only links to it and never fetches it, so a LAN address is fine |
| `accepts` | optional, the work messages this connector takes: `submit`, `diagnose`, `stop` ([Work messages](#work-messages-phase-3-who-asked-and-who-pays)). Leave it out until the connector implements them. Up to 20 words matching `^[a-z_]{1,32}$`; unknown ones are kept |

FF Factory answers with `welcome`:

```json
{ "type": "welcome", "protocol": 1, "provider": "ffbox",
  "cursors": { "conversation": "2026-09-27T09:20:00Z#812", "intake": "20260927T090000Z-desync-3a9f01c2d4" },
  "limits": { "maxMessageBytes": 65536, "messagesPerSecond": 100, "burst": 1000, "helloTimeoutMs": 10000, "invalidPerMinute": 20 } }
```

`cursors` holds the `cursor` of the last `conversation` and `intake` message FF Factory stored. A
stream FF Factory has never seen has no cursor. After the welcome, the connector sends the current
`capacity`, then everything newer than each cursor, oldest first, and then live updates as they
happen.

## Messages from the connector

Unknown fields are dropped, and a field that fails its rule makes the message invalid.

### `capacity`

What each container class offers now. Send it after the welcome, whenever a number changes, and at
least every 5 minutes.

```json
{ "type": "capacity", "queue": 2, "state": "running", "holds": [],
  "classes": [
    { "name": "ffagent",    "network": "fenced", "gpu": false, "model": "claude-opus-5-5", "tier": "full",
      "models": [ { "requester": "operator", "model": "claude-opus-5-5", "tier": "full" },
                  { "requester": "discord",  "model": "glm-5.3-flash",   "tier": "simple" } ],
      "unity": ["batchmode", "playtest-softgl"], "free": 4, "max": 6, "note": "player text; no git credential" },
    { "name": "ffdev",      "network": "open",   "gpu": false, "model": "claude-opus-5-5", "tier": "full",
      "unity": ["batchmode"], "free": 1, "max": 3, "note": "operators only; read-only git credential" },
    { "name": "ffdiagnose", "network": "fenced", "gpu": false, "model": "claude-opus-5-5", "tier": "full",
      "unity": ["batchmode", "mode2-pair"], "free": 2, "max": 3 } ] }
```

The Claude model names in this example are illustrative. What is not: operator work runs on the
requesting operator's own Claude plan at full capability, and Discord work runs GLM-5.3 Flash in the
fenced class (Lothsahn, 2026-09-28).

| field | rule |
|---|---|
| `classes[].name` | `^[a-z][a-z0-9_-]{0,31}$`; at most 10 classes |
| `network` | `fenced` (the egress fence, no git credential) or `open` (the internet) |
| `gpu` | a boolean. `false` for every FFBox class today |
| `model` | the model FF Factory's own work (operator-requested or automatic) runs on in this class, `^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$` |
| `tier` | the tier of that work: `full` (any well-briefed task) or `simple` (small, well-scoped work only: small fixes, triage, log reading, docs, dependency bumps). Operator work is `full` |
| `models` | optional, at most 4: the model and tier per kind of requester, `{ "requester": "operator" \| "discord", "model", "tier" }`, one entry per requester. When given, the portal shows these and not `model`/`tier`; keep `model` and `tier` equal to the `operator` entry so older portals stay right. Leave a requester out when it cannot reach the class (`ffdev` has no `discord` entry) |
| `unity` | the Unity modes a run of this class can use: `batchmode`, `playtest-softgl`, `mode2-pair`, `editor-mcp`. Other words matching `^[a-z0-9][a-z0-9-]{0,31}$` are kept as given. At most 12 |
| `free`, `max` | whole numbers from 0 to 1,000,000 |
| `note` | optional, at most 200 characters, shown as given |
| `queue` | turns waiting for a container |
| `state` | `running`, `draining`, `updating` or `stopped` |
| `holds` | why work waits, one line each (a subscription hold, quiet hours); at most 10 of 160 characters |

### `conversation`

One conversation, new or changed. Send it on every state change. FF Factory keeps the newest 500,
keyed by `id`.

```json
{ "type": "conversation", "cursor": "2026-09-27T09:20:00Z#812",
  "conversation": { "id": "812", "source": "intake", "opener": "operator",
    "title": "Desync minerBots+census at heartbeat 7240", "state": "running", "agentClass": "ffdiagnose",
    "branch": "ffbox/miner-census-812", "key": "desync:0.50.0:minerBots+census",
    "createdAt": "2026-09-27T09:00:00Z", "updatedAt": "2026-09-27T09:20:00Z" } }
```

| field | rule |
|---|---|
| `cursor` | 1-120 characters, opaque to FF Factory. It must increase in the order the connector sends; `<updated_at>#<id>` works |
| `id` | `^[A-Za-z0-9._:-]{1,80}$`, FFBox's conversation id |
| `source` | `discord`, `intake`, `codereview`, `fff`, `shell`, `web` or `other` |
| `opener` | `operator`, `player`, `fff` or `system`. **Never a name, handle or id** |
| `title` | up to 2000 characters, of which FF Factory keeps 300. **Untrusted text**: it can quote a player. FF Factory strips control characters, redacts secrets, renders it as plain text and treats it as data. Still, prefer FFBox's own summary title over a player's raw words |
| `state` | `queued`, `running`, `idle`, `blocked` or `closed` |
| `agentClass` | the class of its latest turn |
| `branch` | optional, `^[A-Za-z0-9._/+-]{1,200}$` |
| `pr` | optional, `{ "number": 640, "state": "open" \| "merged" \| "closed" }` |
| `verdict` | optional, `^[A-Z][A-Z-]{0,39}$`, for example `NEEDS-INFO` or `ESCALATE` |
| `costUsd` | optional, 0 or more |
| `key` | optional, the board's dedupe key when FFBox knows it (`^[A-Za-z0-9_:#.+/-]{1,160}$`), for example `desync:0.50.0:minerBots+census` |
| `url` | optional, `https://`, where a person reads it on FFBox's page |
| `createdAt`, `updatedAt` | ISO 8601 with a zone |

### `intake`

One report `ffintake` filed. Send it once per report, in the order they were filed. FF Factory keeps the
newest 2000 and ignores a `reportId` it already has.

```json
{ "type": "intake", "cursor": "20260927T090000Z-desync-3a9f01c2d4",
  "event": { "reportId": "20260927T090000Z-desync-3a9f01c2d4", "kind": "desync",
    "receivedAt": "2026-09-27T09:00:00Z", "gameVersion": "0.50.0.35", "platform": "WindowsPlayer",
    "bytes": 2400000, "sender": "3ace6eea57acd768",
    "desync": { "group": "fc5620980cd46738", "correlationId": "7-7240-2", "divergedClient": 2,
      "role": "host", "localClient": 0, "sessionEpoch": 7, "verdictHeartbeat": 7240,
      "divergedSurfaces": "minerBots+census", "happenedAt": "2026-09-27T08:59:40Z" } } }
```

**Only facts `ffintake` computed or pattern-checked go in here: its manifest and the `desync` block.**
Never send the description, log lines, file names from inside the zip, or the sender's address.

| field | rule |
|---|---|
| `cursor` | as for conversations; the report id works, since ids sort by receive time |
| `reportId` | `^\d{8}T\d{6}Z-(crash\|desync)-[0-9a-f]{6,32}$` |
| `kind` | `crash` or `desync` |
| `receivedAt` | ISO 8601 with a zone |
| `gameVersion`, `platform` | `^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`, as `ffintake` checked them |
| `bytes` | the report's size |
| `sender` | optional, 8-64 hex characters. **Re-key `address_hash`** with a salt kept on FFBox (HMAC-SHA256 of the hash, first 16 hex characters is plenty), so FF Factory can count distinct senders but cannot match FFBox's hashes |
| `desync` | optional. The fields of `ffintake`'s `desync` block, camel-cased: `group` (hex or null), `correlationId`, `divergedClient`, `role` (`host`/`client`), `localClient`, `sessionEpoch`, `verdictHeartbeat`, `divergedSurfaces` (`ffintake`'s `SURFACES_RE`), `happenedAt`, `why` (`^[a-z_]{1,40}$`). Leave `session_guid` and the combined fingerprints out: FF Factory does not need them |

## Messages from FF Factory

| message | when |
|---|---|
| `welcome` | the answer to a valid `hello` (above) |
| `error` | `{ "type": "error", "code": "bad_json" \| "bad_message" \| "unknown_type" \| "hello_twice" \| "not_enabled", "message": "…", "ref": "<type or ref>" }`. A message was not taken, and the connection stays up. `message` names the field and the rule, never the value. `not_enabled`: a `request` or `board_check` while FF Factory has that part of the intake off. Log it |
| `filed`, `board` | the answers to `request` and `board_check` ([The intake](#the-intake-requests-and-the-ledger-check)) |

Ignore any other message type: protocol 2 may add some.

## Work messages (phase 3): who asked and who pays

FF Factory sends these only once phase 3 ships, and only to a connector that listed them in `hello.accepts`.
The schemas are `SubmitSchema`, `DiagnoseSchema`, `StopSchema`, `AcceptedSchema` and `RefusedSchema` in
`server/providerProtocol.ts`, tested in `server/providerWork.test.ts`.

### `requestedBy`: the person the work is for

Every work message names one person, an FF Factory login:

```json
"requestedBy": { "userId": "lothsahn", "displayName": "Lothsahn" }
```

| field | rule |
|---|---|
| `userId` | the FF Factory login name, `^[a-zA-Z0-9._-]{2,32}$`. Stable: it never changes for a person. **This is the only field that picks an account** |
| `displayName` | 1-40 characters on one line: no control characters, and none of `<` `>` `{` `}` `$` `\` `[` `]` or a backtick. For FFBox's pages and logs only |

`requestedBy` holds exactly these two fields. It carries **no credential, email or token**, and FF Factory
builds every work message strictly (`buildSubmit` and the others refuse any field they do not know), so none
can ride along. FF Factory redacts anything shaped like a secret from `title` and `prompt` before sending.

Who it is:

- **A person asked** (`"trigger": "person"`): the login that wrote the message, pressed the button, or whose
  message the orchestrator acted on (docs/identity.md, "The shared orchestrator chat").
- **FF Factory started it by itself** (`"trigger": "automatic"`, intake triage from phase 4): the configured
  system payer, config `systemPayer`. That is Ben, per his decision.

**FFBox MUST:**

1. **Pick the Claude account by `requestedBy.userId`, and only by it.** Map it through the `operators` block:
   the entry whose `fff` id is that user id, and the credential that entry names. Ben's entry names the token
   Ben gave Lothsahn privately. Lothsahn's names his own account. The same applies to `trigger: "automatic"`,
   which arrives as the system payer.
2. **Refuse work for a person it has no account for**, and never fall back to another person's account or a
   default one. Answer `refused` with `unknown_requester` (no operator with that `fff` id) or `no_account`
   (an operator with no Claude account to bill).
3. **Say whose account it charged** in `accepted.billedTo`: the user id, never the credential. It must equal
   `requestedBy.userId`. FF Factory flags any other value.
4. Record the person on the conversation, as `fff:<userId>`, the way `/intake` records `web:<login>`.

Tokens never cross the connector in either direction. FF Factory holds no FFBox credential, and FFBox
receives none from FF Factory.

### FF Factory → connector

```json
{ "type": "submit", "id": "fff-7c1e", "requestedBy": { "userId": "lothsahn", "displayName": "Lothsahn" },
  "trigger": "person", "title": "Fix the belt splitter", "prompt": "…", "class": "fenced",
  "untrustedInput": false, "base": "develop", "key": "issue#640" }
{ "type": "diagnose", "id": "fff-7c1f", "requestedBy": { "userId": "ben", "displayName": "Ben" },
  "trigger": "automatic", "reportIds": ["20260927T090000Z-desync-3a9f01c2d4"], "key": "desync:0.50.0:minerBots+census" }
{ "type": "stop", "id": "fff-7c20", "requestedBy": { "userId": "ben", "displayName": "Ben" }, "conversation": "813" }
```

| field | rule |
|---|---|
| `id` | FF Factory's request id, `^[A-Za-z0-9._:-]{1,80}$`. The replies refer to it as `ref` |
| `requestedBy` | above. Required on all three |
| `trigger` | `person` or `automatic` (submit and diagnose) |
| `title` | 1-300 characters, redacted. Untrusted: it can quote what a person pasted |
| `prompt` | 1-48,000 characters, redacted |
| `class` | `fenced` (the default) or `open`. `untrustedInput: true` never goes with `open` |
| `untrustedInput` | the task reads text from outside the team; forces the fenced class |
| `base`, `branch` | optional git refs, `^[A-Za-z0-9._/+-]{1,200}$` |
| `conversation` | optional on submit: a conversation FF Factory started, whose next turn this is. Required on stop |
| `reportIds` | diagnose: 1-20 report ids as in `intake` |
| `key` | optional, the board's dedupe key |

FFBox may refuse anything, and it picks the class by its own rules. A request can only make the class
stricter.

### Connector → FF Factory

```json
{ "type": "accepted", "ref": "fff-7c1e", "conversation": "813", "billedTo": "lothsahn" }
{ "type": "refused", "ref": "fff-7c1e", "reason": "no_account", "message": "fff:lothsahn has no Claude account configured" }
```

| field | rule |
|---|---|
| `ref` | the request's `id` |
| `conversation` | accepted: the FFBox conversation id, as in `conversation` messages |
| `billedTo` | accepted: the user id whose account FFBox charges. Must be `requestedBy.userId` |
| `reason` | refused: `unknown_requester`, `no_account`, `class_not_allowed`, `budget_hold`, `draining`, `already_diagnosed`, `bad_request` or `other` |
| `message` | optional, up to 300 characters, one line for people. Shown as data |

FF Factory takes these two, and `result` below, from any connector; they change only a request it submitted (a
`ref` it knows). It sends `submit` only when its config `providers.ffbox.sendWork` is on (docs/intake.md).

```json
{ "type": "result", "ref": "fff-w12-lx3", "conversation": "813", "state": "done", "branch": "ffbox/fff-w12",
  "pr": 771, "verdict": "FIX-PROPOSED", "summary": "…", "url": "https://ffbox.example/conv/813" }
```

`result` (connector → FF Factory): a turn FF Factory submitted ended. `state` `done` or `failed`; `branch`, `pr`,
`verdict` (`^[A-Z][A-Z-]{0,39}$`), `noBranchReason` (300), `summary` (2000, untrusted text), `costUsd` and `url`
are optional. A pushed branch makes FF Factory start a worker that reviews and merges it.

## The intake: requests and the ledger check

FF Factory's work ledger is where both teams' work is recorded (docs/intake.md). These messages let FFBox file into
it and ask it before starting work. FF Factory answers them only while its config `intake.ffbox` has them on;
otherwise it sends `error` `not_enabled` and FFBox carries on as before. Schemas: `RequestSchema`,
`BoardCheckSchema` and `ResultSchema` in `server/providerProtocol.ts`, tested in `server/providerWork.test.ts`.

```json
{ "type": "request", "ref": "r-2291", "kind": "review-branch", "title": "Fix alt-tab freeze", "brief": "…",
  "opener": "player", "conversation": "812", "branch": "ffbox/alt-tab-1", "pr": 770 }
{ "type": "filed", "ref": "r-2291", "workId": "w41", "status": "pending_approval" }

{ "type": "board_check", "ref": "q-17", "keys": ["branch:ffbox/alt-tab-1", "pr#770"], "title": "alt-tab freeze" }
{ "type": "board", "ref": "q-17", "verdict": "in_flight",
  "matches": [{ "id": "w23", "status": "active", "title": "Fix the alt-tab freeze", "score": 0.8, "why": "similar title", "updatedAt": "2026-09-29T10:00:00.000Z" }] }
```

`request` (connector → FF Factory):

| field | rule |
|---|---|
| `ref` | FFBox's id for it, `^[A-Za-z0-9._:-]{1,80}$`; `filed` refers to it. Resending it (or the same conversation) files nothing new |
| `kind` | `review-branch` (a fix branch to review and merge), `escalate` (work FFBox cannot do: a GPU, the three-machine rig), `dev` (an operator's request) |
| `title`, `brief` | 1-300 and 1-8000 characters. Untrusted unless `opener` is `operator`: FF Factory quotes it as players' text |
| `opener` | `operator`, `player` or `system`: who started the conversation behind it. Say `player` for anything a player started |
| `requestedBy` | optional, as in the work messages: the operator it is for. FF Factory checks the login exists; otherwise it is the system payer's |
| `conversation`, `branch`, `pr`, `verdict`, `key`, `url` | optional, the same patterns as in `conversation` |

`filed` (FF Factory → connector): `workId` (the ledger request, or the one it repeats), `status` (`pending_approval`
until one of the reviewers approves it: players' reports do not steer the game; otherwise the request's status),
`repeat: true` for a repeat, or `status: "skipped"` with `why` past FF Factory's daily cap.

`board_check` (connector → FF Factory), before FFBox works a report or starts an operator's dev turn: `ref`, up to 20
`keys` in the board's spelling (`branch:<name>`, `pr#N`, `issue#N`, `spec-NNN`, a desync signature, a conversation
id), and an optional `title` whose words are compared (untrusted; never shown to a model).

`board` (FF Factory → connector): `verdict` `in_flight` (a strong match is open), `done` (a strong match finished
within FF Factory's lookback, default 14 days) or `clear`, and up to five `matches`, strongest first: ledger id,
status, title (120 characters), score 0 to 1 (0.8 and over is strong), why, last change. Never a brief. FFBox MUST
NOT pass a match's title into a container that runs player text.

**FFBox SHOULD** skip work whose check says `in_flight` or `done`, and point at the ledger id instead (an operator
may override), so the two teams never build the same fix twice.

## Limits and close codes

- Rate: a token bucket of 1000 messages refilled at 100 a second, which is enough for a catch-up of
  a few thousand messages. Pace a larger backlog. Past the limit, FF Factory closes with `4429`.
- More than 20 invalid messages in a minute closes with `4400`.
- FF Factory pings every 20 s and drops a connection that has been silent for 45 s. The connector
  should do the same: answer pings (any WebSocket library does), and treat 45 s without a frame or
  pong as a dead link, then reconnect.

| close | meaning | connector does |
|---|---|---|
| `1000`, `1001` | normal, or FF Factory shutting down | the normal backoff |
| `4000` | replaced by a newer connection with the same token | nothing, if that was this connector's own reconnect; otherwise log it, because two connectors share one token |
| `4400` | the first message was not a valid `hello`, or too many invalid messages | fix, then retry in 5 minutes |
| `4403` | switched off in FF Factory while connected | retry in 5 minutes |
| `4408` | no `hello` within 10 s | the normal backoff |
| `4426` | FF Factory speaks another protocol | stop, say so in FFBox's journal and status, and retry every hour (an update on either side fixes it) |
| `4429` | too many messages | wait 60 s, then send more slowly |

## Reconnect and backoff

The same pacing the Mac daemons use (`machine/daemon.ts`, `reconnectDelayMs`), which is tuned to how
long an FF Factory restart takes (20-60 s):

- For the first 2 minutes after a drop: retry every 2 s × a random factor between 0.75 and 1.25.
- After that: `min(60 s, 1 s × 2^attempt)` with the same jitter.
- A refused upgrade (`502` from the proxy while FF Factory is down, or a connection error) ends the
  attempt at once. Do not wait out the handshake timeout.
- `401`, `403`, `429`, `4400`, `4403`, `4426` and `4429` use their own waits from the tables above,
  not the fast retry.
- After any reconnect, send `hello` again, and resume from the cursors in the new `welcome`, not from
  memory.

## Kill switch

Either side can end the link on its own:

| side | how | effect |
|---|---|---|
| FFBox | a file, `~/.config/ffbox/fff.disabled` (or wherever Lothsahn prefers), checked every 5 s | the connector closes with `1000` and does not reconnect until the file is gone |
| FFBox | stop the connector's unit | the same, until it is started |
| FF Factory | `providers.ffbox.enabled: false` (`set_app_config` or `config.json`) | the live connection closes with `4403`; new ones get `403` |
| FF Factory | `node server/providerToken.ts --revoke`, or a new token | every connection gets `401` |

## Security checklist for the connector

- No model and no shell built from message content. Protocol 1 needs nothing from FF Factory except
  `welcome` and `error`.
- It reads FFBox state through `ffwatch`'s CLI or a read-only view, and never opens a report zip.
- Its account holds its token and nothing else: not `secrets.env`, not the Docker socket, and not
  the `ffintake` group if `ffwatch intake-events` exists.
- TLS verification on (Funnel has a real certificate), and `wss://` only.
- The token stays out of argv and logs, and is rotated by minting a new one.
- From phase 3: the Claude account for a work message comes from `requestedBy.userId` through the
  `operators` block, and from nothing else in the message. There is no fallback account. No credential
  is ever sent to FF Factory, and none is expected from it.
- No player names, Discord or GitHub ids, addresses or report contents in any message.

## Testing against FF Factory

1. On a development FF Factory (see the README's Development section), set
   `"providers": { "ffbox": { "enabled": true } }` in the test `config.json`, and run `node
   server/providerToken.ts` with `FFSB_CONFIG` pointing at it.
2. `node e2e/mockConnector.ts http://127.0.0.1:8790 <token>` connects, sends sample data and stays
   connected. The FFBox card appears in the sidebar and its page lists the samples.
3. `node --test server/providers.test.ts` holds FF Factory's side of this contract: tokens, statuses,
   the handshake, validation, limits, close codes, cursors across a restart.

## Versioning

Additive changes keep protocol 1: a new optional field, a new message type from FF Factory (which the
connector ignores), or a new `unity` mode. A change that needs both sides updated bumps
`PROVIDER_PROTOCOL`. FF Factory then closes old connectors with `4426`, which tells them to wait for
an update.
