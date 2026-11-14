import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPrivacyRead, checkPrivacyShell, factoryInstalls, privatePath, type PrivacyContext } from './privacyGuard.ts';
import { sandboxGuard } from './guard.ts';

const mac: PrivacyContext = {
  win: false,
  home: '/Users/pat',
  cwd: '/Users/pat/factory/worker/sandboxes/slot1',
  allow: ['/Users/pat/factory/worker/sandboxes/slot1', '/Users/pat/factory/worker/temp/ffa-1', '/Users/pat/factory/worker'],
  installs: ['/Users/pat/other-factory'],
};
const win: PrivacyContext = {
  win: true,
  home: 'C:/Users/pat',
  cwd: 'D:/ffw/sandboxes/slot1',
  allow: ['D:/ffw/sandboxes/slot1', 'D:/ffw/temp/ffa-1', 'D:/ffw'],
  installs: ['F:/ffw'],
};
const refused = (cmd: string, ctx = mac) => checkPrivacyShell(cmd, ctx);

test('a whole-desktop capture is refused; a window, region or own app capture is not', () => {
  for (const cmd of ['screencapture -x /tmp/a.png', 'screencapture ~/x.png', 'ffmpeg -f avfoundation -i "1" out.mp4', 'ffmpeg -f avfoundation -i "0:0" out.mov'])
    assert.match(refused(cmd) ?? '', /privacy guard/, cmd);
  for (const cmd of ['screencapture -l 1234 out.png', 'screencapture -R 0,0,800,600 out.png', 'ffmpeg -i in.mp4 -vf scale=640:-1 out.mp4'])
    assert.equal(refused(cmd), undefined, cmd);
  assert.match(refused('ffmpeg -f gdigrab -i desktop out.mp4', win) ?? '', /privacy guard/);
  assert.match(refused('ffmpeg -f lavfi -i ddagrab out.mp4', win) ?? '', /privacy guard/);
  assert.equal(refused('ffmpeg -f gdigrab -i title="Lens Scout" out.mp4', win), undefined);
});

test('the camera, the microphone and the clipboard are refused; copying to the clipboard is not', () => {
  for (const cmd of ['imagesnap shot.jpg', 'sox -d rec.wav', 'pbpaste > x.txt', 'xclip -o', 'ffmpeg -f avfoundation -i ":0" mic.wav'])
    assert.match(refused(cmd) ?? '', /privacy guard/, cmd);
  assert.match(refused('Get-Clipboard', win) ?? '', /clipboard/);
  assert.equal(refused('echo hi | pbcopy'), undefined);
  assert.equal(refused('sox in.wav out.wav'), undefined);
});

test('ssh and remote desktop to another computer are refused; git over ssh to a forge is not', () => {
  assert.match(refused('ssh pat@studio-pc ls') ?? '', /privacy guard/);
  assert.match(refused('scp a.txt pat@10.0.0.5:/tmp/') ?? '', /privacy guard/);
  assert.equal(refused('ssh -T git@github.com'), undefined);
  assert.equal(refused('git push origin HEAD'), undefined);
});

test('a server on every interface is refused; on loopback it is not', () => {
  for (const cmd of ['python3 -m http.server 8000', 'python3 -m http.server --bind 0.0.0.0 8000', 'nc -l 9000', 'npx vite --host 0.0.0.0'])
    assert.match(refused(cmd) ?? '', /privacy guard/, cmd);
  for (const cmd of ['python3 -m http.server --bind 127.0.0.1 8000', 'ls -a *', 'npx vite --host 127.0.0.1'])
    assert.equal(refused(cmd), undefined, cmd);
});

test("a person's own files, another user's and another factory's folder are refused; the sandbox and temp folder are not", () => {
  for (const p of ['~/Documents/taxes.pdf', '/Users/pat/Desktop', '~/.ssh/id_ed25519', '/Users/pat/Library/Keychains', '/Users/sam/notes.txt', '/Users/pat/other-factory/secrets', '~/.zsh_history'])
    assert.ok(privatePath(p.replace('~', '/Users/pat'), mac), p);
  for (const p of ['/Users/pat/factory/worker/sandboxes/slot1/README.md', '/Users/pat/factory/worker/temp/ffa-1/x', '/Users/Shared/x', '/opt/homebrew/bin/blender', '/Users/pat/.gitconfig'])
    assert.equal(privatePath(p, mac), undefined, p);
  assert.match(refused('cat ~/Documents/taxes.pdf') ?? '', /personal folder/);
  assert.match(refused('ls ../../../../Desktop') ?? '', /personal folder/);
  assert.equal(refused('cd "$TMPDIR/x/y/z/w" && ls ../../../../Desktop'), undefined, 'after a cd the climb is judged by where it lands, which a seatbelt cannot know');
  assert.equal(refused('cat ../slot1/README.md'), undefined);
  assert.equal(refused('cat README.md'), undefined);
  assert.ok(privatePath('C:/Users/pat/AppData/Roaming/discord/Local Storage', win));
  assert.ok(privatePath('F:/ffw/app/secrets', win));
  assert.match(refused('type %USERPROFILE%\\Documents\\a.txt', win) ?? '', /personal folder/);
});

test('the Read, Grep and Glob tools take the same path rule', () => {
  assert.match(checkPrivacyRead('Read', { file_path: '/Users/pat/Downloads/contract.pdf' }, mac) ?? '', /personal folder/);
  assert.match(checkPrivacyRead('Grep', { pattern: 'x', path: '/Users/pat/Library/Messages' }, mac) ?? '', /messages/);
  assert.match(checkPrivacyRead('Glob', { pattern: '*', path: '/Users/sam' }, mac) ?? '', /another user/);
  assert.equal(checkPrivacyRead('Read', { file_path: '/Users/pat/factory/worker/sandboxes/slot1/a.ts' }, mac), undefined);
});

test("factoryInstalls finds the other factories' installs, not the worker's own", () => {
  const dirs: Record<string, string[]> = {
    '/Users/pat': ['/Users/pat/factory', '/Users/pat/other-factory', '/Users/pat/Documents'],
    '/Users/pat/factory': ['/Users/pat/factory/worker', '/Users/pat/factory/claude-worker'],
  };
  const installs = new Set(['/Users/pat/factory/worker', '/Users/pat/other-factory']);
  const exists = (p: string) => [...installs].some((i) => p.startsWith(i + '/'));
  const found = factoryInstalls({ home: '/Users/pat', workerRoot: '/Users/pat/factory/worker', list: (d) => dirs[d] ?? [], exists });
  assert.deepEqual(found, ['/Users/pat/other-factory']);
});

test('the worker guard refuses a whole-desktop capture and a personal-folder read when privacy is on, and not when it is off', async () => {
  const base = { sandboxId: 'slot1', sandboxPath: mac.cwd!, protectedPaths: [], gameRepos: [] };
  const ask = async (privacy: boolean, tool: string, input: Record<string, unknown>) => {
    const hook = sandboxGuard({ ...base, ...(privacy ? { privacy: { win: mac.win, home: mac.home, allow: mac.allow, installs: mac.installs } } : {}) }) as unknown as (i: unknown, id: string | undefined, o: { signal: AbortSignal }) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }>;
    const out = await hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: mac.cwd, session_id: 's', transcript_path: '' }, undefined, { signal: new AbortController().signal });
    return out.hookSpecificOutput?.permissionDecision === 'deny' ? out.hookSpecificOutput.permissionDecisionReason : undefined;
  };
  assert.match((await ask(true, 'Bash', { command: 'screencapture -x "$TMPDIR/desk.png"' })) ?? '', /privacy guard/);
  assert.match((await ask(true, 'Read', { file_path: '/Users/pat/Documents/diary.txt' })) ?? '', /personal folder/);
  assert.equal(await ask(true, 'Bash', { command: 'screencapture -l 42 "$TMPDIR/app.png"' }), undefined);
  assert.equal(await ask(false, 'Read', { file_path: '/Users/pat/Documents/diary.txt' }), undefined);
});
