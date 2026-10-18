import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { unityInstanceName } from '../shared/unityInstance.ts';

/**
 * w1478 (fewer model calls per worker session): the Unity instance name the brief gives, and the "Fewer model calls"
 * section every sandbox worker's brief carries.
 */

test('unityInstanceName: <folder>@sha1(<worktree>/Assets)[:8], the names beast\'s editors answer to', () => {
  // Measured on beast, 2026-10-18: ~/.unity-mcp/unity-mcp-port-<hash>.json of slot1, slot5 and a status file's project.
  assert.equal(unityInstanceName('F:\\ffw\\sandboxes\\slot1'), 'slot1@d0ecefa5');
  assert.equal(unityInstanceName('F:\\ffw\\sandboxes\\slot5\\'), 'slot5@d00a03c3');
  assert.equal(unityInstanceName('F:/ffsb/clone-test'), 'clone-test@571cf09f');
  assert.equal(unityInstanceName('/Users/dev/ffsb/alpha'), `alpha@${createHash('sha1').update('/Users/dev/ffsb/alpha/Assets').digest('hex').slice(0, 8)}`);
});
