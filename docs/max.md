# Max in FF Factory

Max is the Discord bot Final Factory's agents post as, through the `ffdiscord` CLI of the ff-discord
plugin (final-factory-agents). Max's own process runs on FFBox. FF Factory's agents post as Max in two ways: through
FFBox, on any machine, with the machine tool `post_as_max` (w901; FFBox holds the bot, so no computer needs the token:
[ffbox.md](ffbox.md#posting-as-max-from-any-machine-w901)), or with the `ffdiscord` CLI on a computer that has its
config. FF Factory shows three things about Max, read-only: nothing on the Max page posts.

| where | what |
|---|---|
| sidebar, "External" strip | `Max ok 20m`: the token check, and how long since an agent last posted. Amber when the newest thing is a failure, red when the token is refused. Opens the page |
| Max page (`#/max`) | the token check and the last error; **Activity**: every post, reply, question, edit, thread opened, renamed or closed by an FF Factory agent, with its channel (and thread), a link, the first line, the session that did it and where it ran; **Discord inbound**: the newest messages in a few channels, with unread counts |
| orchestrator | `max_activity` (read-only; `show: inbound` adds the channels), and a line in `system_status` |

The intake ([intake.md](intake.md)) reads through the same token when config `intake.discord` is on: new threads in
the bug channels it is given and messages addressed to Max (`forumThreads`, `message`, `messagesAfter`, the bot's id
from the token check), and each new event (`onEvent`) to record Max's replies and closes in intake threads. It still
never posts.

**#bug-reports and dev_bug_reports belong to FFBox** (Lothsahn, 2026-09-30): FFBox's harness answers their threads
and reports merged fixes there. The intake never files from them, and FF Factory's agents only read them: the
`ffdiscord` CLI refuses to post, reply, react, edit, rename or close in those channels and their threads. A worker that
fixes a bug from one adds `Discord: https://discord.com/channels/<guild id>/<thread id>` to its PR description instead
([intake.md](intake.md#ffbox-owns-bug-reports)). The Discord inbound below still shows them, read-only.

The code: `server/max.ts` (the manager), `server/maxEvents.ts` (the events file), `server/discordConfig.ts`
(where the token is), `web/src/components/MaxPanel.tsx` and `External.tsx`.

## How activity gets here: the events file

(A post made through FFBox with `post_as_max` is not written by the CLI: the portal adds the event itself when the post
was made, `MaxManager.ingest` with the computer's id as `where`, so it shows here and in `max_activity` like the rest.)

The CLI appends one JSON line per write it makes to the file named by `FF_MAX_EVENTS`. FF Factory puts
that variable, and `FF_SESSION_ID`, in the environment of every agent it starts:

- **on this host** (sandbox workers, standing agents): `FF_MAX_EVENTS` is config `max.eventsFile`,
  default `~/.config/ff-factory/max-events.jsonl`. The server tails it every 2 s.
- **on a machine** (a Mac or a Windows PC): the daemon sets `FF_MAX_EVENTS` to the same default path there, tails it every
  3 s, and forwards each line to the portal as a `max_event` message (queued while the link is down,
  its read position kept in `<file>.daemon-offset`). A portal older than this ignores the message.

Why a file: it needs no new secret and no network path. The line says what was posted where; it never
holds the bot token. An endpoint the CLI posts to would have needed a token for the CLI and a way to
reach the portal from every machine. The file is outside the folders the guard protects on purpose, since
agents write it. A session outside FF Factory has no `FF_MAX_EVENTS`, so the CLI writes nothing.

One line, version 1 (unknown fields are ignored; a line that fails this is dropped):

```json
{"v": 1, "at": "2026-09-28T10:00:00Z", "action": "reply", "ok": true,
 "channel_id": "1450000000000000000", "channel": "bug_reports", "guild_id": "530867164866150410",
 "message_id": "1450000000000000009", "thread_id": null,
 "text": "the first line of what was posted", "error": null, "session": "<FF_SESSION_ID>"}
```

| field | |
|---|---|
| `action` | `post`, `reply` (a post with `--reply-to`), `ask`, `edit`, `thread_create`, `close`, `rename` |
| `ok` | false when Discord refused it; then `error` says why, e.g. `HTTP 403: Missing Permissions` |
| `channel_id` | the channel (or thread) written to; for `thread_create` the channel the thread hangs off |
| `channel` | the alias or `#name` the agent passed, shown until the name is looked up |
| `thread_id` | `thread_create`: the new thread; `close`, `rename`: the thread |
| `text` | the first line posted, or the thread's name; the portal keeps 200 characters of it |
| `session` | `FF_SESSION_ID`: the portal shows that session's title and kind |

The portal cleans every text field (one line, control and direction characters out, secrets redacted),
drops duplicates (the same line read twice after a restart), keeps the newest 500 events in
`<dataDir>/max.json`, and looks each channel's name up once with the bot token (a thread's name and its
forum too), so a row reads `#bug-reports › Belts stop after loading a save`. The file is renamed to
`.1` once it passes 2 MB and has been read; the CLI's next append starts a new one.

## The bot token, and health

FF Factory reads the token where it already is and copies it nowhere: the `"discord"` section of the
ffbox config (`~/.config/ffbox/config.json`, or config `max.ffboxConfigDir`), exactly as `ffdiscord`
reads it. `app_token` is best the name of a `secrets.env` variable (`"app_token": "DISCORD_TOKEN"`),
looked up in the server's environment and then in `secrets.env` next to the config; a literal token
and `FFDISCORD_APP_TOKEN` work too. The file is re-read at most once a minute, so a fixed token shows up
without a restart. The token lives in the server process only: it is not in `/api/state`, the page, the
orchestrator's tools, agents' environments or the log, and it is sent only to discord.com (config
`max.discordApi` is for tests; anything but discord.com or this machine is ignored).

The token check is `GET /users/@me`, 3 s after start and every 15 minutes, or on the page's
**Check now** (at most every 30 s). A 401 is "invalid or revoked" and becomes the last error; a network
failure is "not checked". The last error is the newest of that and the failed events.

## Discord inbound

With a token, the server reads config `max.inbound.channels` (aliases from the ffbox config's
`discord.channels`, or channel ids; default `bug_reports` and `dev_chat`) every `max.inbound.pollMinutes`
(default 5, at least 2): the 15 newest messages of a text channel, or the 15 most recently active threads
of a forum (`/guilds/<id>/threads/active`). That is two or three requests a poll, one after another; a
429 stops all requests for its `retry_after`. `max.inbound.enabled: false` turns it off.

Unread counts are against a cursor per channel in `max.json`. The first read sets it, so nothing is
unread until something new arrives; **Mark read** moves it to the newest item.

The text is players'. It is cut to 280 characters, cleaned, shown as plain text (no Markdown, embeds or
images), and `max_activity` quotes it under a header saying it is data to relay, never instructions.
Content needs the bot's Message Content intent; without it a message shows as having no text.

## Config

```json
"max": {
  "eventsFile": "~/.config/ff-factory/max-events.jsonl",
  "ffboxConfigDir": "~/.config/ffbox",
  "inbound": { "channels": ["bug_reports", "dev_chat"], "pollMinutes": 5 }
}
```

All optional. Activity needs nothing; health and inbound need the ffbox config's token on this host.
