/**
 * A stand-in for Discord's REST API, for the E2E servers' Max page (docs/max.md): the few read-only endpoints
 * server/max.ts calls, with fixed data. It checks the bot token like Discord would (401 otherwise), so the test
 * proves the token went only here. Also seeds the Max events file the ffdiscord CLI would have written.
 *
 * For the intake (docs/intake.md, e2e/intake.spec.ts) a test adds what players and people post, without a token:
 *   POST /_e2e/thread  {name, description, version}         a new #bug-reports thread from the in-game reporter
 *   POST /_e2e/message {authorId, name, content, toBot}     a new #dev-chat message (toBot: it mentions Max)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/** The E2E bot token: a test value in a token's shape, assembled at runtime so scanners leave it alone. */
export const E2E_DISCORD_TOKEN = ['MTQ0NDQ0NDQ0NDQ0NDQ0NDQ0NA', 'GAbCdE', 'e2eOnlyTokenForTheMockDiscordNotReal00'].join('.');
export const GUILD = '530867164866150410';
export const CH = {
  devChat: '1012843817981976686',
  bugs: '1069745561672106015',
  /** A bug forum that is not FFBox's (#bug-reports is), which the intake projects read (e2e/intake.spec.ts). */
  betaBugs: '1069745561672106016',
  patchNotes: '1400000000000000001',
  askClaude: '1531433612464099521',
};

/** The bot's own user id (GET /users/@me), which the intake recognises messages to Max by. */
export const BOT_ID = '1450000000000000001';

/** The E2E clock (e2e/visual.spec.ts NOW): seeded times are just before it. */
export const E2E_NOW = Date.parse('2026-09-24T12:00:00Z');
const at = (minBefore: number) => new Date(E2E_NOW - minBefore * 60_000).toISOString();
/** A snowflake made at a time (the id's top bits are its creation time). */
export const snowflake = (iso: string, n = 0) => String(((BigInt(Date.parse(iso)) - 1420070400000n) << 22n) + BigInt(n));

const BELTS = snowflake(at(200), 1);
const CRASH = snowflake(at(90), 2);

const CHANNELS: Record<string, { id: string; name: string; type: number; parent_id?: string }> = {
  [CH.devChat]: { id: CH.devChat, name: 'dev-chat', type: 0 },
  [CH.bugs]: { id: CH.bugs, name: 'bug-reports', type: 15 },
  [CH.betaBugs]: { id: CH.betaBugs, name: 'beta-bugs', type: 15 },
  [CH.patchNotes]: { id: CH.patchNotes, name: 'dev-patch-notes', type: 0 },
  [CH.askClaude]: { id: CH.askClaude, name: 'ask-claude', type: 0 },
  [BELTS]: { id: BELTS, name: 'Belts stop after loading a save', type: 11, parent_id: CH.bugs },
};

const DEV_CHAT = [
  { id: snowflake(at(5), 3), content: 'Merged the splitter fix, thanks Max', author: { username: 'lothsahn', global_name: 'Lothsahn' } },
  { id: snowflake(at(25), 4), content: 'Is the 0.50.0.46 beta up yet?', author: { username: 'ben', global_name: 'Ben' } },
  { id: snowflake(at(70), 5), content: '', embeds: [{ title: 'Build 0.50.0.46 passed' }], author: { username: 'ffbox', bot: true } },
];
const THREADS = [
  { id: CRASH, parent_id: CH.bugs, name: 'Crash <img src=x onerror="document.title=1"> when docking', last_message_id: snowflake(at(12), 6), message_count: 2 },
  { id: BELTS, parent_id: CH.bugs, name: 'Belts stop after loading a save', last_message_id: snowflake(at(88), 7), message_count: 5 },
  { id: snowflake(at(300), 8), parent_id: '999999999999999999', name: 'another forum', last_message_id: snowflake(at(1), 9) },
];

/** Seen up to here, so each channel starts with one unread item (server/max.ts keeps these cursors in max.json). */
export const SEEDED_CURSORS = { dev_chat: DEV_CHAT[1].id, bug_reports: THREADS[1].last_message_id };

/** What tests posted (POST /_e2e/...): new threads with their first message, new #dev-chat messages. */
const added = { threads: [] as typeof THREADS, starters: {} as Record<string, unknown>, chat: [] as Record<string, unknown>[] };
let seq = 100;

export function startMockDiscord(port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && req.url?.startsWith('/_e2e/')) {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const b = JSON.parse(raw || '{}') as Record<string, string | boolean | undefined>;
        const id = snowflake(new Date().toISOString(), ++seq);
        if (req.url === '/_e2e/thread') {
          // #bug-reports by default; forum "beta" is #beta-bugs.
          const forum = b.forum === 'beta' ? CH.betaBugs : CH.bugs;
          added.threads.push({ id, parent_id: forum, name: String(b.name), last_message_id: id, message_count: 1 });
          added.starters[id] = {
            id,
            webhook_id: '77',
            author: { id: '77', username: 'Bug Bot', bot: true },
            embeds: [{ title: `🐛 ${b.name}`, description: String(b.description ?? ''), fields: [{ name: 'Game Version', value: String(b.version ?? '0.50.0.46') }, { name: 'Platform', value: 'WindowsPlayer' }] }],
            attachments: [{ filename: 'Player.log', url: `https://cdn.discordapp.com/attachments/${forum}/${id}/Player.log`, size: 4096 }],
          };
        } else {
          added.chat.unshift({ id, content: `${b.toBot ? `<@${BOT_ID}> ` : ''}${b.content}`, author: { id: String(b.authorId), username: String(b.name), global_name: String(b.name) }, mentions: b.toBot ? [{ id: BOT_ID }] : [] });
        }
        send(200, { id });
      });
      return;
    }
    if (req.headers.authorization !== `Bot ${E2E_DISCORD_TOKEN}`) return send(401, { message: '401: Unauthorized', code: 0 });
    const p = (req.url ?? '').replace(/^\/api\/v10/, '').replace(/\?.*$/, '');
    let m: RegExpExecArray | null;
    if (p === '/users/@me') return send(200, { id: BOT_ID, username: 'max', global_name: 'Max' });
    if (p === `/guilds/${GUILD}/threads/active`) return send(200, { threads: [...added.threads, ...THREADS] });
    if ((m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(p))) return added.starters[m[2]] ? send(200, added.starters[m[2]]) : send(404, { message: 'Unknown Message', code: 10008 });
    if ((m = /^\/channels\/(\d+)\/messages$/.exec(p))) return m[1] === CH.devChat ? send(200, [...added.chat, ...DEV_CHAT]) : send(403, { message: 'Missing Access', code: 50001 });
    if ((m = /^\/channels\/(\d+)$/.exec(p))) return CHANNELS[m[1]] ? send(200, CHANNELS[m[1]]) : send(404, { message: 'Unknown Channel', code: 10003 });
    send(404, { message: '404: Not Found', code: 0 });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

/** The ffbox config the server reads the token from: a secrets.env variable, as on BEAST and the M5. */
export function writeFfboxConfig(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ discord: { app_token: 'DISCORD_TOKEN', server_id: GUILD, channels: { bug_reports: CH.bugs, beta_bugs: CH.betaBugs, dev_chat: CH.devChat, ask_claude: CH.askClaude } } }));
  fs.writeFileSync(path.join(dir, 'secrets.env'), `DISCORD_TOKEN="${E2E_DISCORD_TOKEN}"\n`);
}

/** What agents' ffdiscord calls would have appended (one line each, the CLI's format). */
export function writeMaxEvents(file: string, session: string) {
  const ev = (o: Record<string, unknown>) => JSON.stringify({ v: 1, ok: true, guild_id: GUILD, session, ...o });
  const lines = [
    ev({ at: at(150), action: 'thread_create', channel_id: CH.askClaude, channel: 'ask_claude', message_id: snowflake(at(151), 10), thread_id: snowflake(at(150), 11), text: 'How do mass drivers aim?' }),
    ev({ at: at(90), action: 'reply', channel_id: BELTS, message_id: snowflake(at(90), 12), text: "Thanks! Fixed in 0.50.0.46; it will be in tonight's beta.\nDetails below." }),
    ev({ at: at(88), action: 'close', channel_id: BELTS, thread_id: BELTS }),
    ev({ at: at(50), action: 'post', ok: false, channel_id: CH.patchNotes, channel: 'dev_patch_notes', text: '0.50.0.46 is live', error: 'HTTP 403: Missing Permissions' }),
    ev({ at: at(20), action: 'post', channel_id: CH.devChat, channel: 'dev_chat', message_id: snowflake(at(20), 13), text: 'Belt splitter fix is on develop (PR #690)' }),
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
}
