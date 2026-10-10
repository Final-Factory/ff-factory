import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permissionAccess, permissionWhat } from '../shared/permissionAccess.ts';

const BEN = { userId: 'ben', displayName: 'Ben' };

test('w891: a worker\'s own people answer its permission requests; any owner does too; a member who is not on it does not', () => {
  const worker = { requestedBy: BEN };
  assert.equal(permissionAccess({ userId: 'ben', role: 'owner' }, worker, [BEN]), 'own');
  assert.equal(permissionAccess({ userId: 'Ben', role: 'member' }, worker, []), 'own', 'who started it, whatever the case of the login');
  assert.equal(permissionAccess({ userId: 'cara', role: 'member' }, { requestedBy: BEN }, [{ userId: 'cara' }]), 'own', 'a request of hers is on it');
  assert.equal(permissionAccess({ userId: 'lothsahn', role: 'owner' }, worker, [BEN]), 'owner');
  assert.equal(permissionAccess({ userId: 'cara', role: 'member' }, worker, [BEN]), undefined);
  assert.equal(permissionAccess({ userId: 'cara', role: undefined }, worker, [BEN]), undefined, 'a login the portal does not know is no owner');
});

test('w891: the line a notice shows for a tool call is a shell command\'s text, else the tool and its input', () => {
  assert.equal(permissionWhat('Bash', { command: 'rm -rf\n  build', description: 'Clean' }), 'rm -rf build');
  assert.equal(permissionWhat('Write', { file_path: '/a/b' }), 'Write {"file_path":"/a/b"}');
  assert.equal(permissionWhat('mcp__x__go', undefined), 'mcp__x__go');
  assert.equal(permissionWhat('Bash', { command: 'x'.repeat(500) }).length, 160);
});
