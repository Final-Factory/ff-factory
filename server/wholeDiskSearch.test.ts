import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkSearchTool, checkWholeDiskSearch, type WholeDiskContext } from './wholeDiskSearch.ts';
import { pluginEnv } from './pluginPaths.ts';
import { sandboxGuard } from './guard.ts';

// w2012: whole-disk searches are refused on every machine; searches inside the sandbox, the temp folder and the install folder pass.
const SKILLS = 'C:\\Users\\loth\\.claude\\plugins\\cache\\final-factory-agents\\ff-agents\\1.31.31\\skills';
const WIN: WholeDiskContext = { win: true, home: 'C:\\Users\\loth', cwd: 'V:\\ffw\\sandboxes\\slot2', skills: SKILLS };
const MAC: WholeDiskContext = { win: false, home: '/Users/ben', cwd: '/Users/ben/ffw/sandboxes/slot1', skills: '/Users/ben/.claude/plugins/cache/final-factory-agents/ff-agents/1.31.31/skills' };
const LINUX: WholeDiskContext = { win: false, home: '/home/ff', cwd: '/home/ff/ffw/sandboxes/slot1' };

const refused = (cmd: string, ctx: WholeDiskContext) => assert.match(checkWholeDiskSearch(cmd, ctx) ?? '', /^Refused: /, cmd);
const fine = (cmd: string, ctx: WholeDiskContext) => assert.equal(checkWholeDiskSearch(cmd, ctx), undefined, cmd);

test('the searches the workers ran are refused (w2012: 7f785004, 1225e6c6, the 08:05Z process)', () => {
  refused('"C:\\Program Files\\Git\\usr\\bin\\find.exe" / -name ui_look.py -not -path */node_modules/*', WIN);
  refused('find / -name "ui_look.py" 2>/dev/null | head', WIN);
  refused('find / -name "pr_evidence.py" 2>/dev/null', WIN);
  refused('find / -name ui_look.py 2>/dev/null | head -5', MAC);
  refused('find / -name ui_look.py', LINUX);
});

test('every spelling of a whole drive or the whole file system is refused on Windows', () => {
  for (const cmd of [
    'find C:\\ -name ui_look.py',
    'find C:/ -name ui_look.py',
    'find /c -name ui_look.py',
    'find /c/ -name ui_look.py',
    'find /cygdrive/c -name x',
    'find /mnt/c -name x',
    'find V:/ -name x',
    'find /v -name x',
    'find "C:\\" -name x',
    'find / /v/ffw -name x',
    'cd / && find . -name ui_look.py',
    'cd /c; find -name ui_look.py',
    'cmd /c dir /s /b C:\\ui_look.py',
    'dir /s C:\\',
    'dir C:\\ /s /b',
    'Get-ChildItem -Recurse C:\\ -Filter ui_look.py',
    'Get-ChildItem -Path C:\\ -Recurse -Filter ui_look.py -ErrorAction SilentlyContinue',
    'gci C:\\*.py -r',
    'Get-ChildItem C:\\Users -Recurse -Include ui_look.py',
    'ls -R /',
    'ls -Recurse C:\\',
    'where /r C:\\ ui_look.py',
    'powershell -Command "Get-ChildItem -Recurse C:\\ -Filter pr_evidence.py"',
    'bash -c "find / -name ui_look.py"',
    'rg --files / | grep ui_look',
    'rg -l ui_look /c',
    'grep -rl ui_look C:/',
    'grep -r --include=*.py ui_look /',
    'fd ui_look.py /',
    'fd -e py ui_look C:\\',
    'du -sh /c',
    'tree /',
    'find ~ -name ui_look.py',
    'find $HOME -name ui_look.py',
    'Get-ChildItem $env:USERPROFILE -Recurse -Filter ui_look.py',
    'find C:/Users/loth -name ui_look.py',
    'timeout 60 find / -name x',
    'sudo find / -name x',
  ])
    refused(cmd, WIN);
});

test('macOS and Linux: the root, the user folders and a home folder are refused', () => {
  for (const cmd of ['find / -name x', 'find /Users -name x', 'find /Volumes -name x', 'find ~ -name ui_look.py', 'find ~/ -name x', 'find /Users/ben -name x', 'rg --files ~ ', 'grep -R ui_look /Library', 'fd ui_look /', 'du -sh /System', 'cd ~ && find . -name x'])
    refused(cmd, MAC);
  for (const cmd of ['find / -name x', 'find /home -name x', 'find /home/ff -name x', 'grep -rn ui_look /', 'find /mnt -name x'])
    refused(cmd, LINUX);
});

test('searches in the sandbox, the temp folder, the install folder and the plugin folder stay allowed', () => {
  for (const cmd of [
    'find . -name "*.cs"',
    'find Assets -name ui_look.py',
    'find "$TMPDIR" -name "*.log"',
    'find $TMPDIR/ffa -name ui_look.py',
    'find V:/ffw/tools -name ui_look.py',
    'find /v/ffw/sandboxes/slot2 -name x',
    'find "$FF_SKILLS" -name "*.py"',
    'rg ui_look',
  ])
    fine(cmd, WIN);
  fine('grep ui_look /etc/hosts', WIN); // not recursive
  fine('grep -n "find /" server/guard.ts', WIN); // the pattern is no path
  fine('rg "find /" server', WIN);
  fine('rg -n -e "/" server', WIN);
  fine('ls -r /', WIN); // a reverse sort, no walk
  fine('ls /', MAC);
  fine('ls ~', MAC);
  fine('find ~/ffw -name x', MAC);
  fine('find ~/.claude/plugins -name ui_look.py', MAC);
  fine('du -sh ~/ffw/tmp', LINUX);
  fine('Get-ChildItem C:\\ ', WIN); // one level, no walk
  fine('dir C:\\', WIN);
  fine('python "$FF_SKILLS/unity-ui/ui_look.py" colour a.png', WIN);
  fine(`python "${SKILLS}\\unity-ui\\ui_look.py" pack x`, WIN);
  fine('echo "find / -name x"', WIN);
  fine('git log --grep "find /"', WIN);
});

test('the refusal names where the plugin scripts are', () => {
  const msg = checkWholeDiskSearch('find / -name ui_look.py', WIN)!;
  assert.match(msg, /\$FF_SKILLS\/unity-ui\/ui_look\.py/);
  assert.ok(msg.includes(SKILLS), msg);
  assert.match(msg, /Stop messing with my c:/);
  assert.match(checkWholeDiskSearch('find / -name x', LINUX)!, /Base directory for this skill/);
});

test('the Grep and Glob tools over a whole disk are refused; inside the sandbox they pass', () => {
  assert.match(checkSearchTool('Grep', { pattern: 'ui_look', path: '/' }, MAC) ?? '', /^Refused: Grep/);
  assert.match(checkSearchTool('Glob', { pattern: '**/ui_look.py', path: 'C:\\' }, WIN) ?? '', /^Refused: Glob/);
  assert.match(checkSearchTool('Glob', { pattern: 'C:/**/ui_look.py' }, WIN) ?? '', /^Refused: Glob/);
  assert.match(checkSearchTool('Glob', { pattern: '/**/pr_evidence.py' }, LINUX) ?? '', /^Refused: Glob/);
  assert.match(checkSearchTool('Grep', { pattern: 'x', path: '~' }, MAC) ?? '', /^Refused: Grep/);
  assert.equal(checkSearchTool('Glob', { pattern: '**/*.cs' }, WIN), undefined);
  assert.equal(checkSearchTool('Grep', { pattern: 'x', path: 'Assets/Scripts' }, WIN), undefined);
  assert.equal(checkSearchTool('Glob', { pattern: 'V:/ffw/tools/**/ui_look.py' }, WIN), undefined);
  assert.equal(checkSearchTool('Read', { file_path: '/' }, WIN), undefined);
});

test('the sandbox guard refuses a root-level find on every OS and passes one in the sandbox', async () => {
  for (const [platform, home, sandbox] of [
    ['win32', 'C:\\Users\\loth', 'V:\\ffw\\sandboxes\\slot2'],
    ['darwin', '/Users/ben', '/Users/ben/ffw/sandboxes/slot1'],
    ['linux', '/home/ff', '/home/ff/ffw/sandboxes/slot1'],
  ] as const) {
    const guard = sandboxGuard({ sandboxId: 'slot2', sandboxPath: sandbox, protectedPaths: [], platform, home, env: { FF_SKILLS: '/skills' } });
    const ask = (tool: string, input: Record<string, unknown>) =>
      guard({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, session_id: 's', transcript_path: '', cwd: sandbox, tool_use_id: 't' } as never, 't', { signal: new AbortController().signal });
    const out = (await ask('Bash', { command: 'find / -name ui_look.py' })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', platform);
    assert.match(out.hookSpecificOutput?.permissionDecisionReason ?? '', /\/skills/);
    const grep = (await ask('Grep', { pattern: 'x', path: '/' })) as { hookSpecificOutput?: { permissionDecision?: string } };
    assert.equal(grep.hookSpecificOutput?.permissionDecision, 'deny', platform);
    const ok = (await ask('Bash', { command: 'find . -name "*.py"' })) as { hookSpecificOutput?: { permissionDecision?: string } };
    assert.notEqual(ok.hookSpecificOutput?.permissionDecision, 'deny', platform);
  }
});

test('pluginEnv names the ff-agents plugin Claude Code installed, else FF Factory\'s own checkout, else nothing', () => {
  const home = path.join('/h');
  const file = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  const installed = path.join('/h', '.claude', 'plugins', 'cache', 'final-factory-agents', 'ff-agents', '1.31.31');
  const json = JSON.stringify({ version: 2, plugins: { 'ff-agents@final-factory-agents': [{ scope: 'user', installPath: installed, version: '1.31.31' }] } });
  const read = (p: string) => {
    if (p === file) return json;
    throw new Error('ENOENT');
  };
  const all = () => true;
  assert.deepEqual(pluginEnv({ env: {}, home, readFile: read, exists: all }), { FF_AGENTS_PLUGIN: installed, FF_SKILLS: path.join(installed, 'skills') });
  // CLAUDE_CONFIG_DIR moves the file.
  assert.deepEqual(pluginEnv({ env: { CLAUDE_CONFIG_DIR: '/elsewhere' }, home, readFile: read, exists: all }), {});
  // No file: FF Factory's own checkout in the install folder.
  const co = path.join('/w', 'tools', 'final-factory-agents', 'plugins', 'ff-agents');
  assert.deepEqual(pluginEnv({ env: {}, home, root: '/w', readFile: () => '{', exists: all }), { FF_AGENTS_PLUGIN: co, FF_SKILLS: path.join(co, 'skills') });
  // An installPath whose folder is gone, and no checkout: nothing.
  assert.deepEqual(pluginEnv({ env: {}, home, root: '/w', readFile: read, exists: () => false }), {});
});
