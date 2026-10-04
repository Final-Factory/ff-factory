# FFBox connector contract (provider protocol 2)

What FFBox's connector must do to talk to FF Factory. Written for Lothsahn, who builds the connector in
the ffbox repo. The design and the reasons behind it are in [ffbox-integration.md](ffbox-integration.md).
FF Factory's side is `server/providers.ts`. The schemas are in `server/providerProtocol.ts`, the
source of truth when this page and the code disagree. A working reference client is
`e2e/mockConnector.ts`.

Protocol 1 is **read-only**. The connector reports capacity, conversations and intake reports, and
FF Factory records and shows them. Nothing FF Factory sends asks FFBox to do anything.

**Protocol 2** (2026-09-29, [Protocol 2](#protocol-2-the-ledger-check-both-ways)) adds what the ledger check both ways
needs: each side says what it takes (`hello.accepts`, `welcome.accepts`), a conversation names its Discord thread
(`threadId`), and FFBox asks the ledger before it starts a fix (`board_check`) and follows the answer (`board`,
pushed again as it changes). Still, nothing FF Factory sends starts anything on FFBox: a `board` answer is data that
FFBox's host code reads to decide whether to start a turn of its own.

**No negotiation** (Lothsahn, 2026-10-03). FFBox runs ffbox master, so neither side gates anything on what the other
says it offers. The hello's `protocol`, `accepts` and `queries` are optional and kept only for display; FF Factory never
closes a link over a protocol number and never reconnects to change what it takes. It sends any query and any `board`
update; FFBox answers or says why not. See [The envelope](#the-envelope-what-is-fatal-and-what-is-not).

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

## The envelope: what is fatal and what is not

Every frame, both ways, is one JSON object with a string `type`. `id` (a query) or `ref` (everything else) ties an
answer to what it answers. The rules are the same on both sides:

- **Unknown fields are ignored.** A reader drops fields it does not know and never refuses a message for having them.
  A missing optional field takes its default.
- **An unknown type is not fatal.** FF Factory answers it with
  `{"type": "error", "code": "unsupported", "ref": "<the type>", "message": "…"}`, logs it once per type per link,
  and does not count it toward the invalid-message limit. The connector does the same, or ignores it.
- **A frame that cannot be read at all closes the link with `4400`:** not JSON, not an object, no string `type`, or a
  known type with a required field missing or a field of the wrong JSON type (a string where a number belongs). The
  close reason, at most 120 bytes, says where: `could not parse capacity.classes.0.free: expected number, received
  string`. Before the hello, anything but a valid `hello` is fatal the same way. A frame over 64 KB is closed by the
  WebSocket layer with `1009`.
- **A value that breaks a rule is not fatal:** a number out of range, a string that does not match its pattern, a
  whole number that is not whole. FF Factory answers `error` `bad_message` naming the field and the rule (never the
  value), counts it, and closes with `4400` only past 20 in a minute.

FF Factory logs every close with the code and reason either side sent, and shows the last one in FFBox's status line
(`system_status`, `ffbox_activity`, the FFBox card): for its own parse failures,
`connector closed: could not parse <type>.<path>: <detail> (ffbox commit <7 hex>, from <ip>)`. When the connector cannot
parse something FF Factory sent, it closes with `4400` and its own reason the same way, and FF Factory shows that.

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
{ "type": "hello", "protocol": 2, "provider": "ffbox",
  "connector": { "version": "1.0.0", "commit": "abc1234" },
  "web": "https://ffbox.lan:8787" }
```

| field | rule |
|---|---|
| `protocol` | optional, a whole number, information only. Any number, or none, is welcomed |
| `provider` | `"ffbox"` |
| `connector.version` | 1-40 characters of `A-Z a-z 0-9 . _ + -` |
| `connector.commit` | optional, 7-40 hex characters |
| `web` | optional, an `https://` URL where people read FFBox's own page. FF Factory only links to it and never fetches it, so a LAN address is fine |
| `accepts` | optional, information only: what the connector takes, e.g. `board`, `filed`, `board_maybe`, `query`, and later the work messages `submit`, `diagnose`, `stop`. Shown on the FFBox card. Words matching `^[a-z_]{1,32}$` are kept (20 at most); others are dropped, not refused. Gates nothing, except that a phase 3 `submit` still goes only to a connector that lists it ([Work messages](#work-messages-phase-3-who-asked-and-who-pays)) |
| `queries` | optional, information only: the read-only queries it answers. FF Factory asks any query whatever this says |

FF Factory answers with `welcome`:

```json
{ "type": "welcome", "protocol": 2, "provider": "ffbox",
  "cursors": { "conversation": "2026-09-27T09:20:00Z#812", "intake": "20260927T090000Z-desync-3a9f01c2d4" },
  "limits": { "maxMessageBytes": 65536, "messagesPerSecond": 100, "burst": 1000, "helloTimeoutMs": 10000, "invalidPerMinute": 20 },
  "accepts": ["board_check", "board_summary", "request", "accepted", "refused", "result", "metrics",
              "dev_request", "dev_chunk", "dev_message", "dev_received", "updater", "report_chunk", "report_end"] }
```

`protocol` echoes the hello's when it is `1` or `2`, and is `2` otherwise. `accepts` is the same static list on every
welcome: everything FF Factory's code handles, whatever its settings. A `board_check` or `request` while that part of
the intake is off is answered `error` `not_enabled` with the `ref`, so a change of settings never closes the link.

`cursors` holds the `cursor` of the last `conversation` and `intake` message FF Factory stored. A
stream FF Factory has never seen has no cursor. After the welcome, the connector sends the current
`capacity`, then everything newer than each cursor, oldest first, and then live updates as they
happen.

## Messages from the connector

Unknown fields are dropped. A field of the wrong JSON type, or a required one missing, closes the link; a value that
breaks its rule is answered `bad_message` ([The envelope](#the-envelope-what-is-fatal-and-what-is-not)).

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
| `ffwatch` | optional, `{ "up": true \| false, "at": "<ISO time>"? }`: whether `ffwatch`, which writes the feed the connector reads, is running. `at` is when it last wrote; `up: false` means down or restarting since then. The status line says `ffwatch up` or `ffwatch DOWN since <at>`, and nothing when a capacity leaves it out |

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
| `threadId` | protocol 2, optional, `^\d{15,25}$`: the Discord thread the conversation lives in (a forum post's thread, or a reply chain's root message). FF Factory keys it `discord:<threadId>`, which is how an `ffbox/*` review request and a board check find each other |
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
| `error` | `{ "type": "error", "code": "bad_message" \| "unsupported" \| "hello_twice" \| "not_enabled", "message": "…", "ref": "<type or ref>" }`. A message was not taken, and the connection stays up. `bad_message`: a value broke its rule; `message` names the field and the rule, never the value. `unsupported`: a type FF Factory does not know (`ref` is the type). `not_enabled`: a `request` or `board_check` while FF Factory has that part of the intake off. Log it |
| `filed`, `board` | the answers to `request` and `board_check` ([The intake](#the-intake-requests-and-the-ledger-check)) |
| `dev_ack`, `dev_filed`, `dev_reply` | the answers to an operator's `dev_request` and `dev_message`, and later replies to that conversation ([Dev requests](#dev-requests-an-operators-ffdev-turn-handed-to-ff-factory)) |

A type the connector does not know is not fatal: answer `error` `unsupported` with the type as `ref`, or ignore it.

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

{ "type": "board_check", "ref": "conv-812", "keys": ["discord:1554582984567562253"], "conversation": "812" }
{ "type": "board", "ref": "conv-812", "verdict": "in_flight",
  "matches": [{ "id": "w50", "status": "active", "title": "Lag when leading a fleet", "score": 1, "why": "same discord 1554582984567562253",
                "updatedAt": "2026-09-29T10:00:00.000Z",
                "watch": { "repo": "Final-Factory/FinalFactory", "branch": "sandbox/lag-lead", "pr": 812, "target": "develop" } }] }
{ "type": "board", "ref": "conv-812", "verdict": "done", "update": true,
  "matches": [{ "id": "w50", "status": "done", "title": "Lag when leading a fleet", "score": 1, "why": "same discord 1554582984567562253",
                "updatedAt": "2026-09-30T08:00:00.000Z",
                "version": null, "mergedIn": "develop@abc1234def5678", "branch": "sandbox/lag-lead" }] }
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
`keys` in the board's spelling, an optional `conversation` (protocol 2: FFBox's conversation id; the ledger requests
filed from that conversation are its own and never match), and an optional `title` (300) and `summary` (1000: the
report's start), sanitized on FFBox (every welcome lists `board_summary`). Their words are compared with
each ledger request's title and brief by meaning (server/boardMatch.ts): untrusted, never shown to a model. Send
`discord:<thread id>` for a `bug_report` or `suggestion` turn and `report:<report id>` for an intake diagnosis: an exact
key is a match whatever the words say. Other spellings still work:
`branch:<name>`, `pr#N`, `issue#N`, `spec-NNN`, a desync signature, a conversation id. FF Factory gives every
ledger request that names a Discord thread (a `discord.com/channels/…` link or a bare thread id, in its title, brief
or related ids) the key `discord:<thread id>`, including requests filed before this existed.

`board` (FF Factory → connector): `verdict` `in_flight` (a match in the high band is open), `done` (one finished
within FF Factory's lookback, default 14 days), `maybe` (only medium-band matches: it may be the same bug; sent whatever
the hello lists) or `clear`; `confidence`, the strongest
match's score; and up to five `matches`, strongest first: ledger id, status, title (120 characters), score 0 to 1, why,
last change. Never a brief. The bands are config `intake.ffbox.match` (`high` 0.7, `medium` 0.45 by default): an exact
key is high; by words, high also needs a shared concept few requests hold and two shared concepts that say which bug it
is, so a vague report is `maybe` at most. On `maybe` FFBox starts its turn, and whatever it files from that
conversation later is noted on the new request with the candidates, for a person to merge. FFBox MUST NOT pass a
match's title into a container that runs player text. Protocol 2 adds, per match:

| field | on | what |
|---|---|---|
| `watch` | an open match, when FF Factory knows the branch | `{ "repo", "branch", "pr"?, "target" }`: the branch the fix is being made on (the worker's PR head branch, with `pr` once a PR is open, else its sandbox branch such as `sandbox/lag-lead`), the repo (`Final-Factory/FinalFactory`, config `intake.ffbox.repo` or the game repo's URL) and the branch it lands on (`develop`). FFBox watches it for the merge, read-only |
| `version` | a done match | the first release (`FFVersion.cs` bump on the base branch) that contains the fix, e.g. `0.50.0.51`; `null` while it is merged but not yet released ("coming in the next beta build") |
| `mergedIn` | a done match | `<target>@<sha>`, e.g. `develop@abc1234`, when the fix commit is known; else `null` |
| `branch` | a done match | the branch the work was on, when known |

**Updates** (protocol 2): while the link is up, FF Factory re-checks every answer it gave `in_flight` (or `done` with
`version: null`) each minute, for up to 30 days, and sends the `board` again with the same `ref` and `"update": true`
when what FFBox acts on changed: the verdict, a match's status, `watch` (a PR opened, a branch renamed), `version`,
`mergedIn`, whatever the hello listed. FF Factory forgets these on a restart, so the connector
re-sends `board_check` for everything it still follows after every (re)connect.

**FFBox MUST** (its host code, never a container):

- fail open: without an answer within a few seconds, with `error` `not_enabled`, or with FF Factory unreachable, start
  its turn as it would have;
- on `in_flight`: start no turn, set the returned `watch.branch` (and `pr`) as the conversation's branch and watch it
  read-only for the merge; never push to it;
- on `done`: start no turn, and reply with its usual merged notice filled with `version` ("the next beta build" when it
  is `null`);
- use only `verdict`, the ids, statuses, `watch`, `version`, `mergedIn` and `branch`, validated against the patterns
  above. Titles and `why` are for logs at most.

**FFBox SHOULD** skip work whose check says `in_flight` or `done`, and point at the ledger id instead (an operator
may override), so the two teams never build the same fix twice.

## Dev requests: an operator's ffdev turn, handed to FF Factory

An operator's ffdev turn (a Discord message, `ffwatch submit`, ffweb, #codereview) can go to FF Factory instead of a
container on FFBox (design: ffbox `design/fff_dev_requests_design.txt`, w240). FF Factory files it at once, as the
request of the person the operator maps to, deduplicated against its ledger, and answers with the line FFBox posts.
Later, the operator's messages in that conversation reach their orchestrator, and its replies come back. Schemas:
`DevRequestSchema`, `DevChunkSchema`, `DevMessageSchema` and `DevReceivedSchema` in `server/providerProtocol.ts`, the
types `DevAck`, `DevFiled` and `DevReply` beside them; FF Factory's side is `server/devRequests.ts`, tested in
`server/devRequests.test.ts`. FFBox's side of the operator's experience is in [ffbox.md](ffbox.md#dev-requests).

```json
{ "type": "dev_request", "ref": "dev-570-3", "operator": { "name": "lothsahn", "discord": "222222222222222222" },
  "conversation": { "id": "570", "source": "discord", "channel": "dev_chat", "title": "…", "url": "https://discord.com/channels/…/1555…",
                    "threadId": "1555000000000000001", "createdAt": "2026-10-03T09:00:00Z" },
  "title": "Add a cargo filter to the hauler panel", "brief": "…", "keys": ["discord:1555000000000000001"],
  "attachments": [{ "n": 0, "name": "battleship.zip", "size": 104857600, "sha256": "…", "kind": "save" }] }
{ "type": "dev_ack", "ref": "dev-570-3", "ok": true }
{ "type": "dev_chunk", "ref": "dev-570-3", "n": 0, "offset": 0, "data": "<base64 of up to 45000 bytes>" }
…
{ "type": "dev_filed", "ref": "dev-570-3", "ok": true, "outcome": "filed", "workId": "w123", "text": "Filed as w123." }

{ "type": "dev_message", "ref": "msg-570-9", "request": "w123", "operator": { "name": "lothsahn" }, "conversation": "570", "text": "…" }
{ "type": "dev_ack", "ref": "msg-570-9", "ok": true }
{ "type": "dev_reply", "id": "r-mg8x2-1a2b3c", "request": "w123", "conversation": "570", "text": "…", "from": "orchestrator" }
{ "type": "dev_received", "id": "r-mg8x2-1a2b3c" }
```

Connector → FF Factory:

| message | fields |
|---|---|
| `dev_request` | `ref` (`^[A-Za-z0-9._:-]{1,80}$`, "dev-<conversation>-<turn>"); `operator` `{ name, discord?, github?, shell?, web? }`, the name as FFBox's config `operators` has it (`^[A-Za-z0-9._-]{1,40}$`); `conversation` `{ id, source (discord, codereview, shell, web), channel? (the watch alias), title (300), url?, threadId?, branch?, pr?, createdAt }`; `title` (1-120) and `brief` (1-8000), redacted on FFBox; `transcript` (optional, 24000, newest last); `keys` (up to 20: `discord:<thread>`, `branch:<name>`, `pr:<n>`, `report:<id>`; any other is dropped, not refused); `attachments` `[{ n, name, size, sha256, kind? }]`, `n` from 0, each once; `force` (optional: file it even if it repeats work, `!fff new`) |
| `dev_chunk` | `ref`, `n`, `offset`, `data`: file `n`'s bytes from `offset`, base64, at most 45000 bytes raw a frame, in order, file after file |
| `dev_message` | `ref`; `request`, the work id the conversation is linked to (`^w\d+$`); `operator`; `conversation`, the id; `text` (1-4000), redacted; `attachments` (optional, w344) as on `dev_request`: the conversation's files no earlier hand-over delivered (FFBox's `fff_dev_file`), streamed as `dev_chunk`s after the `dev_ack` |
| `dev_received` | `id`: a `dev_reply` or `dev_update` was written for ffwatch, so FF Factory stops resending it |

FF Factory → connector:

| message | when and what |
|---|---|
| `dev_ack` | at once (well within 10 s) after `dev_request` or `dev_message`: `{ ref, ok, error?, detail? }`. `ok: false`, FFBox runs the turn itself: `unknown_operator` (the operator's name, as FFBox's `operators` block gives it, is no FF Factory login), `rate_limited` (`providers.ffbox.devRequests.perHour`, 20 an hour per person), `not_enabled` (`providers.ffbox.devRequests.enabled` off), `bad_request` (the files not numbered 0, 1, 2, … each once; for `dev_message`, a request or conversation that is not linked, or another operator's). `detail` is one line for logs |
| `dev_filed` | after the last byte of a `dev_request` (at once for one without files); for a `dev_message` only when its files failed (`sha_mismatch`, `bad_request`), which never undoes its delivery: `{ ref, ok, outcome?, workId?, matches?, text, error?, detail? }`. `outcome`: `filed` (a new request), `covered` (joined to open work `workId`), `fixed` (`workId` is done: `text` names the release and PR), `linked` (filed as `workId`, with candidates it may repeat). `matches`: `[{ id, status, score, why }]`. `text`, at most 1000 characters, is the line FFBox posts: "Filed as w123.", "Covered by w38 (in progress).", "Already fixed in 0.50.0.69 (PR #412).", "Filed as w124; it may repeat w38, w40.". `ok: false`: `sha_mismatch` (a file's SHA-256 is not the one announced; nothing filed), `bad_request` (a chunk out of order, past its file's size, or for a ref FF Factory is not receiving: send the `dev_request` again), `error` (storing or filing failed) |
| `dev_reply` | later, any number of times: `{ id, request, conversation, text, from }`. `from: "orchestrator"`: the person's orchestrator answered with `reply_to_ffbox` (sent once; FF Factory refuses it while the link is down). `from: "fff"`: FF Factory itself; resent on every new link until `dev_received` names its `id` (before w272 it said "w123 is done: <outcome>"; that is a `dev_update` now). `text` is at most 4000 characters, untrusted: FFBox posts it under its own rules |
| `dev_update` | (w272) whenever the linked request's facts change: `{ id, request, conversation, status, watch?, mergedIn?, version?, branch?, result? }`. `status`: `open`, `done`, `declined` (the ledger's rejected) or `cancelled`. `open` carries `watch` `{ repo, branch, pr, target }` once the worker's PR exists (never a branch without a PR: a sandbox branch carries one task after another). `done` carries `mergedIn` (`<target>@<sha>`, null when it finished with no merge), `version` (the first release that carries it, null until one does) and `branch`; with no merge, `result` is the request's outcome, one line. `declined` and `cancelled` carry the reason as `result` (w278). (w278) `open` also carries `summary` (at most 1000 characters: what was wrong, what changed, how it was verified, "Waiting on review." or "Merging when CI is green.", and the link; no internal ids) and `pr` `{ number, url }` once the worker's PR is ready for review, and `question` while the request waits on its requester (a design question or the dispatcher's); the operator's answer in the thread comes back as `dev_message` and answers the request (it reopens, and the dispatcher resumes it). Facts and results only: FFBox follows the PR, posts the summary once per PR, the question once, its merge notice, and a can't-fix result once; it archives the thread only after a merged fix, never after a can't-fix (Lothsahn, w278). (w299) `held: true` while the request waits in the intake for a reviewer: FFBox records it and posts nothing (w352; until then it posted "Waiting on input from a developer."). Sent for a dev request's conversations and for the conversation a request filed from FFBox's own report, escalation, branch or diagnosis came from. Only the newest per conversation is kept, resent on every new link until `dev_received`. A connector that does not know the type skips it (w351) Where FFBox says each: in a public conversation (its channel's watch entry is not `venue: private`) only `summary` with `pr` (the summary ends "PR #N.", no link), and the merge notice ("Fixed in PR #N, …", no link; w352: nothing public names where the code lives, and Max never posts "Waiting on input from a developer."); `held` is recorded, never said; a `question`, a `result` and every `dev_reply` go to the operator who filed the request by DM, and the operator's reply to that DM comes back as `dev_message` naming the thread's conversation. FF Factory writes `question` and `result` for a developer (internal ids kept) and sends a conversation no operator filed `held` instead of its `question`. A private conversation hears all of it in the thread |

**Repeats and restarts.** A `dev_request` whose `ref` FF Factory already filed is answered `dev_ack` ok and the same
`dev_filed` again, at once and without its files (FF Factory keeps the newest 500 answers across restarts), so a
reconnect mid-hand-over files nothing twice. One that was not filed yet starts over: send it and its files again
from the start. When the link drops while files are arriving, FF Factory drops the partial files; the connector sends
the hand-over again on the next link. A `dev_message` with a `ref` already answered is acknowledged and not relayed
twice.

**Which files, and the caps (w344).** FFBox sends every file it holds for the conversation's inbound messages (a Bug
Bot report earlier in the thread included), each SHA-256 once, chosen newest first and listed in the order posted: at
most 10, 200 MB each, 500 MB together. A follow-up carries the conversation's files no earlier hand-over delivered: new ones, ones left out past the caps, and every file of a conversation handed over before w344 (so conversation 637's next follow-up brings its Bug Bot report).
What FFBox leaves out (no stored copy, empty, too big, past the caps) is named in the `brief` (or the follow-up's
`text`): file name, its Discord link without the signed query, and why. FF Factory no longer refuses a hand-over for
its files: one past `providers.ffbox.devRequests.maxFiles` or `maxRequestMB`, or over `attachments.maxMB`, is
received and dropped, and named in the request's brief ("FFBox handed over files FF Factory did not keep"). A
follow-up's files join its request (`Orchestrators.addDevFiles`), so every worker started for it gets them, and go to
the person's orchestrator and every live worker on it at once. The connector finishes a follow-up as `acked` once its
last chunk is out; a `dev_filed` `ok: false` about its files leaves it `acked`, since its text was delivered at the
ack (before w344 an FF Factory without this answers such chunks `bad_request`, and the text still arrives).

**The chunks.** 45000 bytes raw are 60000 base64 characters, inside the 64 KB frame. The rate limit above
(100 messages a second) is about 4.5 MB/s; the connector's own pace (about 2 MB/s) stays well under it. A chunk out of
order fails the whole hand-over (`dev_filed` `bad_request`); FF Factory answers only the first stray chunk of a ref it
is not receiving, and drops the rest.

**What FF Factory does with it**, for the connector's author to know what the text means (the rules are
[ffbox.md](ffbox.md#dev-requests)): the files go into its attachment store and each SHA-256 is checked; the request is
filed as the mapped person's own, with no approval step; it is deduplicated by the conversation's identity keys, by the
meaning of its title and brief (the ledger check's matcher and bands), and by the scope of open broad requests; the
person's own orchestrator gets one line about it.

## Escalations from Max (HTTP, not the connector)

Max's escalations do not ride the connector: FFBox's host posts them to `POST /api/intake/ffbox` with an API key minted
`node server/apikey.ts ffbox --scope ffbox`, which reaches that endpoint and nothing else (docs/intake.md, "Escalations
from Max"). `Content-Type: application/json`, at most 32 KB, unknown fields refused.

| field | required | rule |
|---|---|---|
| `v` | yes | `1` |
| `ref` | yes | `^[A-Za-z0-9._:-]{1,80}$`, idempotent (e.g. `conv-412-turn-977`): the same ref gets the same answer and files nothing new |
| `conversation` | yes | FFBox's conversation id |
| `kind` | yes | `bug`, `design` or `escalation` |
| `maxClass` | yes | `obvious-bug` or `needs-human`: Max's own call (recorded; FF Factory triages by its own rules) |
| `title` | yes | 1-200 characters, one line, untrusted |
| `diagnosis` | yes | 1-6000 characters, Max's findings, untrusted |
| `report` | no | up to 4000 characters, the player's post, untrusted |
| `threadId` | yes | `^\d{15,25}$` |
| `url` | yes | `https://discord.com/channels/<guild>/<thread>[/<message>]` |
| `channel` | yes | the watch alias, `^[a-z0-9_]{1,40}$` |
| `reporter`, `version`, `platform` | no | a display name (60, untrusted); `^[A-Za-z0-9._+-]{1,40}$` each |
| `attachments` | no | up to 10 `{name, url, bytes?}`, Discord CDN URLs only |
| `verdict` | no | `^[A-Z][A-Z-]{0,39}$` |

The answer is always `200` with one of `{"status":"filed","workId","triage","approval"}` (`approval`: `pending` while
it waits in the intake for a reviewer, which FFBox records and says nothing about (w352), else `approved`; w299), `{"status":"in_flight","workId"}`,
`{"status":"done","workId","version"}` (`version` null while merged but unreleased), `{"status":"skipped","why"}` or
`{"status":"off"}`. `401` a missing or wrong key, `403` a key without scope `ffbox`, `400` a bad body (the field and
the rule, never the value), `413` too large. Retry network errors and 5xx, never 4xx. The ledger check and the filing
happen in one step here, so there is no race between checking and filing.

## Intake diagnoses (HTTP, w361)

When a player's game uploads a desync or crash report and a diagnosis of it finishes on FFBox, FFBox's host files it on
the same endpoint as Max's escalations, `POST /api/intake/ffbox`, with the same `ffbox`-scoped key, the same 32 KB cap
(`413` past it) and the same answers, whether or not it found the root cause or pushed a fix. It carries **no Discord
fields**: `source: "intake"` selects this body (`server/diagnosisRules.ts` `DiagnosisSchema`, strict); a body without
it is read as an escalation, which refuses a `source` field and needs a thread. FFBox ships its side off
(`fff.escalate.intake=false`) and turns it on once this is deployed. FF Factory files it only while
`intake.ffbox.enabled`, `intake.ffbox.escalations` and `intake.ffbox.diagnoses` are on (`off` otherwise).

| field | required | rule |
|---|---|---|
| `v` | yes | `1` |
| `source` | yes | `intake` |
| `ref` | yes | `intake-<conversation>-turn-<turn>` (at most 120), idempotent: the same ref gets the same answer and files nothing new |
| `conversation` | yes | FFBox's conversation id, `^[A-Za-z0-9._:-]{1,80}$`; the ref names it |
| `link` | yes | `https://…`, the diagnosis on FFBox's web page (300) |
| `title` | yes | 1-200 characters, one line, built from the report's facts, never the agent's words |
| `rootCause` | yes | `found` or `not_found` |
| `verdict` | yes | `^[A-Z][A-Z-]{0,39}$` |
| `findings` | yes | up to about 20,000 characters, cut with a marker (20,500 accepted). Untrusted: data only |
| `report` | yes | strict: `kind` (`desync`, `crash`), `lead` and `reportIds` (1-20 ffintake report ids of that kind, the lead first), `gameVersion`, `platform` (`^[A-Za-z0-9._+-]{1,40}$`), `happenedAt` (ISO, optional). A desync may add `group` (hex, or null), `divergedSurfaces`, `heartbeat`, `role` (`host`/`client`), `paired`, `correlationId`, `signature` (`desync:<x.y.z>:<surfaces>`); a crash may add `crashSignature` (one line, 200). Never a session guid; a desync field on a crash (or the other way) is refused |
| `pr` | only if a fix was pushed | strict: `branch` (`ffbox/…`), and when a PR was opened `number`, `url` (`https://github.com/<owner>/<repo>/pull/<n>`) and `base` |
| `attachments` | no | up to 40, strict: `name`, `kind` (`report_zip`, `report_manifest`, `diagnosis_summary`), `bytes`, `sha256` (64 hex), and its fetch locator: `reportId` (and `file` for one file inside the zip) for a report's zip or manifest, fetched with `report {id}` / `{id, file}`; `conversation` for the diagnosis summary, fetched with `conversation {id}` |

**The answer** is `200` with `{"status":"filed","workId",…}` (approved), `{"status":"held","workId"}` (filed, waiting
in the intake for a reviewer), `{"status":"in_flight","workId"}`, `{"status":"done","workId","version"}`,
`{"status":"skipped","why"}` or `{"status":"off"}`. FFBox reads only `status`, `workId` and `version`, each
pattern-checked, and records `workId` on the conversation. `400` names the field and the rule, never the value. Retry
network errors and 5xx with backoff; never a 4xx.

**Matching** (the w312/w331 lesson; docs/intake.md, "Intake diagnoses from FFBox"): it joins ledger work only on an exact
key, among requests that came from a report: a `report:<id>` already on it, the same desync `group`, or, when `pr` is
present, the FFBox review item for that PR or branch (it attaches there rather than opening a second one). A shared
signature or version is at most a "maybe", noted on what it files; the findings' wording never counts. `done` means a
fix released in a version newer than the report's `gameVersion`; merged but unreleased answers `in_flight`; a fix the
forked game already had is not this bug, and a new request is filed.

## Limits and close codes

- Rate: a token bucket of 1000 messages refilled at 100 a second, which is enough for a catch-up of
  a few thousand messages. Pace a larger backlog. Past the limit, FF Factory closes with `4429`.
- More than 20 invalid messages (`bad_message`) in a minute closes with `4400`. Unknown types do not count.
- FF Factory pings every 20 s and drops a connection that has been silent for 45 s. The connector
  should do the same: answer pings (any WebSocket library does), and treat 45 s without a frame or
  pong as a dead link, then reconnect.

| close | meaning | connector does |
|---|---|---|
| `1000`, `1001` | normal, or FF Factory shutting down | the normal backoff |
| `4000` | replaced by a newer connection with the same token | nothing, if that was this connector's own reconnect; otherwise log it, because two connectors share one token |
| `1009` | a frame over 64 KB | fix, then the normal backoff |
| `4400` | a frame FF Factory could not read (the reason says where), the first message was not a valid `hello`, or too many invalid messages | log the reason, fix, then retry in 5 minutes |
| `4403` | switched off in FF Factory while connected | retry in 5 minutes |
| `4408` | no `hello` within 10 s | the normal backoff |
| `4429` | too many messages | wait 60 s, then send more slowly |

## Reconnect and backoff

The same pacing the Mac daemons use (`machine/daemon.ts`, `reconnectDelayMs`), which is tuned to how
long an FF Factory restart takes (20-60 s):

- For the first 2 minutes after a drop: retry every 2 s × a random factor between 0.75 and 1.25.
- After that: `min(60 s, 1 s × 2^attempt)` with the same jitter.
- A refused upgrade (`502` from the proxy while FF Factory is down, or a connection error) ends the
  attempt at once. Do not wait out the handshake timeout.
- `401`, `403`, `429`, `4400`, `4403` and `4429` use their own waits from the tables above,
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

Changes are additive: a new optional field, a new message type, a new query, a new error code, a new `unity` mode.
The envelope rules make each safe to ship on either side first: an unknown field is ignored, an unknown type is
answered `unsupported`, an unknown query is answered `error` `unsupported`. The protocol number is information only;
nothing is gated on it, and FF Factory no longer closes `4426` for a number it does not know (removed 2026-10-03).

## Protocol 2: the ledger check both ways

Since 2026-10-03 a protocol 1 and a protocol 2 hello get the same welcome, answers and pushes ([No
negotiation](#ffbox-connector-contract-provider-protocol-2)). What changed from 1: `hello.accepts` names `board` and `filed`; `welcome.accepts`; `conversation.threadId`;
`board_check.conversation`; the `board` match fields `watch`, `version`, `mergedIn`, `branch`; `board` updates.
FFBox's side: `scripts/fffconnector.py`, `scripts/fff_feed.py` and `scripts/ffwatch.py` in the ffbox repo, behind its
`fff.board_check` switch.

## Read-only queries (protocol 2)

FF Factory can ask FFBox a fixed set of read-only questions on the open link. Nothing new listens anywhere.

```json
{"type": "query", "id": "q-mg1x2-3fa9c01b", "what": "board_log", "args": {"limit": 20}}
{"type": "query_result", "id": "q-mg1x2-3fa9c01b", "what": "board_log", "ok": true, "at": "2026-10-02T10:00:00Z",
 "data": {"entries": [...], "total": 50}}
{"type": "query_result", "id": "q-mg1x2-3fa9c01c", "what": "nope", "ok": false, "error": "unsupported"}
```

- **Not offered, just asked.** FF Factory sends any name matching `^[a-z_]{1,32}$` while the link is up, whatever
  the hello listed (`hello.queries` is shown, never checked). A malformed name is answered `unsupported` by FF Factory
  without sending it. The connector answers a name it does not know with `error` `unsupported`.
- **Answers.** `ok: true` with `data`, an object, and `at`, when FFBox wrote it. Otherwise `ok: false` with `error`:
  `unsupported`, `bad_args`, `not_ready`, `withheld` (a secret scanner matched), `too_large`, `rate_limited`,
  `unavailable` (ffwatch is down), `disabled` (queries are switched off on FFBox), or a newer code kept as given. A
  failure may carry FFBox's own words, each an optional string of at most 300 characters: `reason` (why, e.g.
  `ffwatch down since 2026-10-03T04:28:45Z`), `hint` (what to expect, e.g. `FFBox (commit abc1234) doesn't know this
  query; it may be updating`) and `detail` (what was wrong with the args, e.g. `args.id: a whole number from 1 to
  1000000000000`). FF Factory treats them as untrusted text: one line, control characters out, secrets redacted, 300
  characters kept. An answer is one frame, so the 64 KB frame limit is its cap, and a bigger frame closes the link.
- **Limits.** The connector answers 30 queries a minute and refuses the next 30 with `rate_limited`. Past that it
  drops them unanswered. FF Factory sends at most 30 a minute and 8 at once, and waits 10 s for each answer (15 s for
  `conversation`, `logs`, `reports` and `report`). When it cannot ask or gets no answer, it says why (`no answer from FFBox within 10 s` for a timeout)
  and shows the last good answer it kept, with that answer's time.
- **What answers them.** FFBox's host, never a container or a model. `ffwatch` writes each answer in advance, cut
  down: the config through an allowlist, ids for the ledger log, fixed words and numbers for the status. It scans
  each answer with `secret_in()`. The connector picks the file by the query's name, scans it again, and logs every
  query. Every query is a read; none can write, start a container, change a setting or reach a model.

| `what` | args | `data` |
|---|---|---|
| `config` | none | FFBox's effective config through its allowlist (ffbox `scripts/fff_feed.py`, `CONFIG_ALLOW`): every other value is `"<redacted>"`, and a map the allowlist does not lead into collapses whole. No token, key, password, webhook, path, host, address or person's id; Discord channels as aliases, operators as counts per service |
| `board_log` | `limit`, 1-50, default 20 | `{entries, total}`, newest first: `kind` (`board_check` or `escalate`), `at`, `conversation`, `ref`, `keys`, `verdict` (`clear`, `in_flight`, `done`, `asked`, `no_answer`, `not_asked` with `why`, `error`, or an escalation's `filed`, `pending`, `gave_up`, ...), `matches` (work ids), and for an escalation `state`, `attempts`, `version`, `answeredAt`. No ledger text |
| `conversation` | `id` (required), `offset`, `limit` 1-20 turns (default 5), `text` 200-8000 characters per text | one conversation, answered on demand by `ffwatch` from its database: `conversation` (the `conversation` message's fields plus `kind`, `updatedAt`, `discordLink`, `reportIds`, `ledger`), `turns`, newest first (times, `requester` as a role, `runs` with state, cost, branch, PR and verification, `summary`, the `messages` it answered, the `replies` it posted), `page` (`offset`, `limit`, `total`) and `untrusted`, a label. Every text is redacted on FFBox (secrets taken out, not the answer dropped) and cut with a `[truncated: N more characters]` marker; players appear by display name only, never by id; a held reply shows its status and not its text. Errors also `not_found`, `timeout` (FFBox did not answer within its 12 s), `busy` (4 already waiting). FF Factory waits 15 s for it |
| `logs` | `log` (required, one of `ffwatch`, `fffconnector`, `updater`, `ffintake`, `ffdiscord-listener`, `ffweb`, `modelproxy`, `egress`, `docker`, `githubrunners`), `since`, `until` (epoch seconds, 0 for the last hour up to now), `grep` (at most 200 printable characters), `regex` (at most 100, no quantified group, backreference or lookaround), `limit` 1-2000 lines (default 200), `offset` | that unit set's journal, answered on demand by `ffwatch` on the host (FFBox w268): `log`, `units`, `since`, `until` (ISO), `order` `newest_first`, `offset`, `lines` (each redacted before `grep`/`regex` matched it, cut at 1000 characters), `returned`, `next_offset` while there is more, `scanned`, `scan_capped`, `partial`, `withheld_lines` (lines a secret scan still flagged, left out), `note` (the journal could not be read) and `untrusted`, a label. Args are words as well as whole numbers since FFBox w268; FFBox checks each and answers `bad_args` naming what it wants. A page is at most 48 KB of lines. FF Factory waits 15 s for it |
| `reports` | `id` (one report id), `since`, `until` (epoch seconds of the receive time, 0 leaves that end open), `kind` (`any`, `crash`, `desync`), `version` (exact), `platform` (any case), `signature` (a substring, any case, of the coarse signature or of a diagnosis's crash signature), `session` (a desync's session guid, group or correlation id), `limit` 1-200 (default 50), `offset` | players' crash and desync reports in ffintake's store, read by `ffwatch` on the host (FFBox w320), never written: `order` `newest_first`, `offset`, `reports` (each: `id`, `kind`, `received_at`, `game_version`, `platform`, `bytes`, `sha256`; for a desync `side` (host or client), `group`, `session`, `correlation_id`, `diverged_surfaces`, `paired`, `happened_at`, `why`; `signature` (`desync:<x.y.z>:<surfaces>` or `crash:<x.y.z>`), `crash_signature` and `conversation` when an FFBox diagnosis named them; `files` inside the zip, `name`, `bytes`, `packed`, at most 40 with `files_more`, or `files_note`; `withheld` instead when the view still tripped the secret scan), `returned`, `next_offset`, `keep_days`, `note` and `untrusted`, a label. Every text is redacted on FFBox; the sender's address hash never crosses. A page is at most 44 KB. FF Factory waits 15 s for it |
| `report` | `id` (required), `file` (a name inside the zip exactly as `reports` lists it; empty for the whole zip) | one report (FFBox w320): `report` (as in `reports`, every file listed up to 24 KB), `manifest` (ffintake's, every string redacted, no address hash), `transfer` (`name`, `bytes` at most 64 MB, `sha256`, `chunk_bytes`, `member` for a file, `matches_manifest` for the zip) and `untrusted`; or `refused` (a fixed sentence, e.g. `no such file in the report`) with no `transfer`. The bytes follow the answer as `report_chunk`s and one `report_end` (below). Errors also `not_found` (no such report, or one reached through a symlink), `busy` (one report streams at a time; at most eight copies or 256 MB are staged, each for 5 minutes). FF Factory waits 15 s for the answer and 60 s between frames |
| `status` | none | `box` (`state`, `config` ok or misconfigured, `killed`, `draining`, `dry_run`, `commit`, `since`), `services` (`ffwatch`, `ffweb`, `ffdiscord-listener`, `ffintake`, `fffconnector`, `ffbox-modelproxy`, `ffbox-docker`, `ffbox-egress`, `ffbox-update.timer`: `active`, `inactive`, `failed`, ...), `queue`, `classes` (name, network, model, tier, free, max), `holds`, `dev_requests` (`mode` prefer or off, `ok`, `window_hours`, the counts `handed`, `taken`, `fallback`, `skipped`, and `last_fallback` `{ at, conversation, turn, error }`: operators' ffdev turns of the last 24 hours, `ok` false while the newest decided one fell back and ran on FFBox; an FFBox from before 2026-10-03 sends none), `connector` (version, protocol, since) |

### A report's bytes: `report_chunk` and `report_end` (FFBox w320)

A `report` answer with a `transfer` is followed on the same link by the file it names, staged by `ffwatch` as a copy in
the connector's feed (`<feed>/reports/<query id>/blob`, removed after 5 minutes), so the connector, which cannot read
the report store, never needs to:

```json
{ "type": "report_chunk", "id": "q-mg1x2-3fa9c01b", "offset": 0, "data": "<base64 of up to 45000 bytes>" }
{ "type": "report_end", "id": "q-mg1x2-3fa9c01b", "ok": true, "bytes": 2400000, "sha256": "<64 hex>" }
{ "type": "report_end", "id": "q-mg1x2-3fa9c01b", "ok": false, "error": "changed", "detail": "the staged copy changed while it was sent" }
```

| type | fields |
|---|---|
| `report_chunk` | `id` (the query's), `offset`, `data`: the file's bytes from `offset`, base64, at most 45000 bytes raw a frame, in order |
| `report_end` | `id`, `ok`; with `ok` true `bytes` and `sha256` of what was sent, else `error` and `detail` |

FF Factory takes chunks only for a `report` it asked and whose answer it is still waiting on: each at the offset the
transfer stands at, never past the size the answer said. It stores them as an attachment and checks three SHA-256s
agree: the answer's `transfer.sha256`, `report_end.sha256` and its own of what it stored. Anything else (a gap, a
mismatch, nothing for 60 s, the link dropping) drops what arrived and says why; nothing is kept half. The portal sends
nothing back about a transfer: the only portal→connector message for reports is the `query`.

## `metrics` (protocol 2)

FFBox's load, memory and disks, pushed every 30 s on the open link, always.

```json
{"type": "metrics", "at": "2026-10-02T10:00:00Z",
 "cpu": {"load1": 21.6, "load5": 18.0, "load15": 12.5, "cores": 16},
 "mem": {"totalBytes": 137438953472, "usedBytes": 42949672960, "swapTotalBytes": 8589934592, "swapUsedBytes": 2147483648},
 "disks": [{"role": "root+state", "totalBytes": 536870912000, "freeBytes": 128849018880}]}
```

`cores` is the number of logical cores; FF Factory shows `load1 / cores` as a percentage and does not clamp it, so a box
with more runnable work than cores reads above 100%. Memory in use is MemTotal minus MemAvailable. A disk is named by
role (`root`, `state`, `golden`, `runs`, `cache`, `reports`, `docker`, joined with `+` where they share a filesystem),
never by path; a role outside `^[a-z][a-z+]{0,63}$` is refused. FF Factory keeps the latest and the last half hour of
CPU and RAM percentages, and shows the numbers as stale when none has arrived for two minutes. FFBox does not send a
reading older than five minutes. The `status` query carries the same numbers.

## `updater` (w265)

How FFBox's self-updater's last pass went, per checkout it pulls (ffbox itself, the agents checkout). Written by
FFBox's `scripts/update_state.py` at the start and end of every pass (every 3 minutes) and sent when it changes and
once on every new link; the `status` query's answer carries the same block as `updater`.

```json
{"type": "updater", "updater": {
  "at": "2026-10-03T18:00:00Z", "interval_secs": 180, "ok": false, "since": "2026-10-03T17:00:00Z",
  "running_since": "2026-10-03T18:03:00Z",
  "checkouts": [
    {"name": "ffbox", "path": "/opt/ffbox", "status": "ok", "ok": true, "local": "<40 hex>", "origin": "<40 hex>",
     "since": "2026-10-01T00:00:00Z", "checked_at": "2026-10-03T18:00:00Z", "ok_at": "2026-10-03T18:00:00Z"},
    {"name": "agents", "path": "/opt/final-factory-agents", "status": "diverged", "ok": false,
     "local": "<40 hex>", "origin": "<40 hex>",
     "message": "diverged from origin/master; not taking its commits. Fix it by hand",
     "since": "2026-10-03T17:00:00Z", "checked_at": "2026-10-03T18:00:00Z"}],
  "warnings": ["WARNING: the agents checkout (/opt/final-factory-agents) has diverged from origin/master — ..."]}}
```

Required: `at`, `ok`, and each checkout's `name`, `status` and `ok`; everything else is optional, and unknown fields
are ignored. `status` is a word (`ok`, `ahead`, `diverged`, `dirty`, `failed`, `missing`, `disabled`, or a newer one):
FF Factory goes by `ok`, so FFBox can add a word without a portal release. `since` is when the status (per checkout)
or the overall `ok` began; `ok_at` the last pass that found the checkout ok, `updated_at` the last that moved it to new
commits; `running_since` is present while a pass runs. Paths, commits and the updater's own messages; never a credential.

FF Factory shows FFBox red, "FFBox updates failing: <checkout> <reason>, since <time>", in the sidebar, on the FFBox
page, in `system_status` and in `ffbox_activity` (summary and status), when a checkout is not ok, or when neither `at`
nor `running_since` is newer than three `interval_secs` (180 when absent): a stalled updater counts as failing
(`shared/updaterHealth.ts`). A connector from before w265 sends none and nothing is said. A portal from before w265
answers `error` `unsupported` (ref `updater`), and the connector stops sending it on that link.
