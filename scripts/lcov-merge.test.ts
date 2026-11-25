import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { addLcov, table, uncovered, type FileCov } from './lcov-merge.ts';

const cwd = path.resolve('/repo');

// Two shards' lcov reports of one file, each covering part of it (the shape node's lcov reporter writes).
const shard1 = `TN:
SF:${path.join(cwd, 'server', 'a.ts')}
FN:1,one
FN:5,two
FN:9,anonymous_2
FN:9,anonymous_3
FNDA:3,one
FNDA:0,two
FNDA:1,anonymous_2
FNDA:0,anonymous_3
FNF:4
FNH:2
BRDA:2,0,0,3
BRDA:6,1,0,0
DA:1,3
DA:2,3
DA:5,0
DA:6,0
DA:7,0
DA:9,1
LH:3
LF:6
end_of_record
`;
const shard2 = `TN:
SF:${path.join(cwd, 'server', 'a.ts')}
FN:1,one
FN:5,two
FN:9,anonymous_2
FN:9,anonymous_3
FNDA:0,one
FNDA:2,two
FNDA:0,anonymous_2
FNDA:0,anonymous_3
BRDA:2,0,0,-
BRDA:6,1,0,2
DA:1,0
DA:2,0
DA:5,2
DA:6,2
DA:7,0
DA:9,0
end_of_record
SF:${path.join(cwd, 'shared', 'b.ts')}
FN:1,b
FNDA:1,b
DA:1,1
end_of_record
`;

test('w5679: two shards of one file add up: a line, function or branch either shard ran is covered', () => {
  const files = new Map<string, FileCov>();
  addLcov(files, shard1, cwd);
  addLcov(files, shard2, cwd);
  assert.deepEqual([...files.keys()], ['server/a.ts', 'shared/b.ts']);
  const a = files.get('server/a.ts')!;
  assert.deepEqual([...a.lines], [[1, 3], [2, 3], [5, 2], [6, 2], [7, 0], [9, 1]]);
  assert.equal(a.funcs.get('5,two'), 2);
  assert.equal(a.funcs.get('9,anonymous_3'), 0, 'two functions on one line stay two');
  assert.equal(a.branches.get('6,1,0'), 2);
  assert.equal(a.branches.get('2,0,0'), 3, "a branch the other shard never reached ('-') counts 0");
  const { text, totals } = table(files);
  assert.deepEqual(totals, { files: 2, linePct: (100 * 6) / 7, branchPct: 100, funcPct: 80 });
  assert.match(text, /^server\/a\.ts \|  83\.33 \|   100\.00 \|   75\.00 \| 7$/m);
  assert.match(text, /^all files {3}\|  85\.71 \|   100\.00 \|   80\.00 \|$/m);
});

test('w5679: uncovered lines print as node prints them, in runs', () => {
  assert.equal(uncovered(new Map([[3, 0], [1, 0], [2, 0], [5, 1], [7, 0], [9, 0], [10, 0]])), '1-3 7 9-10');
  assert.equal(uncovered(new Map([[1, 1]])), '');
});
