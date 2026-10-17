// How many chats each sandbox lists in the sidebar's Computers section (w1430), from a portal's data folder, read only:
// before w1430 (the live agents, then "+N stopped") and after it (the chats that matter now, then "+N older"), and which
// slots show a "Live view: go" or "Needs you" call to the person named with --as.
//
//   node scripts/sidebar-chats.ts [data dir, default ./data] [--as <display name>] [--user <user id>]
//
// It reads data/state.json (sessions, machines) and data/work.json (the ledger) and prints counts and request ids only,
// never a transcript, a token or a setting. The live views are not in the data folder: a call it prints is the
// "Needs you" kind, or "Live view: go" when the worker's own declaration says Live view.
import fs from 'node:fs';
import path from 'node:path';
import { fleetOf, slotCall } from '../shared/fleet.ts';
import type { AppState, Machine, SessionInfo, WorkItem } from '../shared/types.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const as = flag('--as') ?? 'Ben';
const user = flag('--user') ?? as.toLowerCase();
const dir = args[0] ?? 'data';

const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as { sessions?: SessionInfo[]; machines?: Machine[] };
const workFile = path.join(dir, 'work.json');
const work = fs.existsSync(workFile) ? (JSON.parse(fs.readFileSync(workFile, 'utf8')) as { items?: WorkItem[] } | WorkItem[]) : [];
const items = Array.isArray(work) ? work : (work.items ?? []);
const app: Pick<AppState, 'sessions' | 'machines' | 'work'> = { sessions: state.sessions ?? [], machines: state.machines ?? [], work: items };

const now = Date.now();
const before = fleetOf({ sessions: app.sessions, machines: app.machines }, undefined, now);
const after = fleetOf(app, undefined, now);
const rows: string[][] = [['slot', 'chats', 'before: listed', 'before: +N stopped', 'after: listed', 'after: +N older', 'call']];
const total = { chats: 0, before: 0, after: 0 };
for (const c of after) {
  for (const sb of c.sandboxes) {
    const was = before.find((x) => x.key === c.key)?.sandboxes.find((x) => x.key === sb.key)?.agents;
    const a = sb.agents;
    const all = a.shown.length + a.older.length;
    // The live views are not on disk: a declared wait that names the Live view stands in for one.
    const views = a.waits.filter((w) => /live view/i.test(w.session.waitingOn?.what ?? '')).map((w) => ({ sessionId: w.session.id, state: 'live' }) as never);
    const call = slotCall(a, views, { userId: user, displayName: as });
    rows.push([sb.key, String(all), String(was?.live.length ?? 0), String(was?.stopped ?? 0), String(a.shown.length), String(a.older.length), call ? `${call.label} (${call.request ?? call.session.id})` : '']);
    total.chats += all;
    total.before += was?.live.length ?? 0;
    total.after += a.shown.length;
  }
}
const width = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
for (const r of rows) console.log(r.map((x, i) => x.padEnd(width[i])).join('  ').trimEnd());
console.log(`\n${rows.length - 1} sandboxes, ${total.chats} chats: ${total.before} listed before w1430, ${total.after} after (as ${as}, ${new Date(now).toISOString()})`);
