import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStrayWrite, resolvedPath } from './strayWrite.ts';
import { sandboxGuard } from './guard.ts';

const mac = {
  sandbox: '/Users/benryding/ffw/sandboxes/slot1',
  temp: '/Users/benryding/ffw/tmp/ffa-75c467b4',
  home: '/Users/benryding',
  exists: () => false,
  skillsCheckout: () => '/Users/benryding/src/final-factory-agents',
};

test('w3257: the two m5 probe files are refused, and the refusal names the temp folder', () => {
  // 75c467b4 (w3241): the `..` climbs out of the sandbox to the home folder.
  const a = checkStrayWrite('/Users/benryding/ffw/sandboxes/slot1/../../../ffw-tmp-placeholder', mac);
  assert.ok(a && a.startsWith('Refused:'), String(a));
  assert.ok(a.includes('(that is /users/benryding/ffw-tmp-placeholder)'), String(a));
  assert.ok(a.includes('Your temp folder is /Users/benryding/ffw/tmp/ffa-75c467b4'), String(a));
  // 3b978270 (w3249): beside the sandboxes, inside the worker install folder but in no folder of the worker's.
  const b = checkStrayWrite('/Users/benryding/ffw/sandboxes/tmp-pr-body-w3249.md', { ...mac, sandbox: '/Users/benryding/ffw/sandboxes/slot3', temp: '/Users/benryding/ffw/tmp/ffa-3b978270' });
  assert.ok(b && b.includes('/Users/benryding/ffw/tmp/ffa-3b978270/<name>'), String(b));
  // A sibling sandbox whose name starts with the worker's own is not the worker's.
  assert.ok(checkStrayWrite('/Users/benryding/ffw/sandboxes/slot10/x.md', mac));
});

test('w3257: new files in the sandbox, the temp folder and the left-open folders pass; existing files are not this rule', () => {
  assert.equal(checkStrayWrite('/Users/benryding/ffw/tmp/ffa-75c467b4/make_bp.py', mac), undefined);
  assert.equal(checkStrayWrite('/Users/benryding/ffw/sandboxes/slot1/Assets/Scripts/New.cs', mac), undefined);
  assert.equal(checkStrayWrite('Assets/Scripts/New.cs', mac), undefined, 'relative: from the sandbox');
  assert.equal(checkStrayWrite('/Users/benryding/.claude/plans/plan.md', mac), undefined);
  assert.equal(checkStrayWrite('/Users/benryding/src/final-factory-agents/plugins/ff-agents/skills/evidence-gate/lessons/x.md', mac), undefined);
  assert.equal(checkStrayWrite('/Users/benryding/Library/Application Support/Never Games/finalfactory/settings.json', mac), undefined);
  assert.equal(checkStrayWrite('C:\\Users\\lothsahn\\AppData\\LocalLow\\Never Games\\finalfactory\\x.json', { ...mac, sandbox: 'V:/ffw/sandboxes/slot1', temp: 'V:\\ffw\\tmp\\ffa-1', home: 'C:\\Users\\lothsahn' }), undefined);
  assert.equal(checkStrayWrite('/Users/benryding/notes.md', { ...mac, exists: () => true }), undefined);
  assert.equal(checkStrayWrite('/Users/benryding/notes.md', { ...mac, temp: '' }), undefined, 'no temp folder known: not checked');
});

test('w3257: Windows paths compare by drive and backslash alike', () => {
  const win = { sandbox: 'V:/ffw/sandboxes/slot2', temp: 'V:\\ffw\\tmp\\ffa-9', home: 'C:\\Users\\lothsahn', exists: () => false, skillsCheckout: () => undefined };
  assert.equal(checkStrayWrite('v:\\ffw\\tmp\\ffa-9\\body.md', win), undefined);
  assert.ok(checkStrayWrite('V:\\ffw\\sandboxes\\slot2\\..\\body.md', win));
  assert.equal(resolvedPath('V:\\ffw\\sandboxes\\slot2\\..\\x', 'V:/'), 'v:/ffw/sandboxes/x');
});

test('w3257: the sandbox guard refuses the stray Write for a worker, and leaves sessions without a worker root alone', async () => {
  const decide = async (g: ReturnType<typeof sandboxGuard>, file_path: string) => {
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path, content: 'x' }, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd: '' };
    const r = (await g(input as never, 'x', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
    return r.hookSpecificOutput?.permissionDecision ?? 'allow';
  };
  const base = { sandboxId: 'slot1', sandboxPath: '/nonexistent-w3257/ffw/sandboxes/slot1', protectedPaths: [], prBase: () => undefined, evidence: () => undefined, home: '/nonexistent-w3257/home' };
  const env = { TMPDIR: '/nonexistent-w3257/ffw/tmp/ffa-1' };
  const worker = sandboxGuard({ ...base, workerRoot: '/nonexistent-w3257/ffw', env });
  assert.equal(await decide(worker, '/nonexistent-w3257/ffw/sandboxes/tmp-pr-body.md'), 'deny');
  assert.equal(await decide(worker, '/nonexistent-w3257/ffw/tmp/ffa-1/pr-body.md'), 'allow');
  assert.equal(await decide(sandboxGuard({ ...base, env }), '/nonexistent-w3257/ffw/sandboxes/tmp-pr-body.md'), 'allow');
});
