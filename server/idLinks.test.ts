import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIdIndex, idSegments, isIdCandidate, linkIdsInTree, resolveIdToken, type IdHastNode } from '../shared/idLinks.ts';

// w6216: the ids an orchestrator names in its chat become links only when the page knows exactly what they name.
const WORKER = 'b6c73b2b-1f0e-4c1a-9d2e-0a1b2c3d4e5f';
const ix = buildIdIndex({
  sessions: [
    { id: WORKER },
    // Two sessions that share the prefix 0123abcd: that prefix names neither.
    { id: '0123abcd-0000-4000-8000-000000000001' },
    { id: '0123abcd-0000-4000-8000-000000000002' },
  ],
  machines: [
    { id: 'beast', name: 'BEAST', sandboxes: [{ id: 'agent4' }, { id: 'slot1' }] },
    { id: 'lothdesktop', name: 'LothDesktop', sandboxes: [{ id: 'sb1' }] },
    { id: 'm5' },
  ],
  work: [{ id: 'w6215' }, { id: 'w12' }],
});

const linked = (text: string) => idSegments(text, ix).filter((s) => s.hit).map((s) => [s.text, s.hit!.kind]);

test('known ids link to what they name', () => {
  assert.deepEqual(resolveIdToken('b6c73b2b', ix), { kind: 'session', sessionId: WORKER });
  assert.deepEqual(resolveIdToken(WORKER, ix), { kind: 'session', sessionId: WORKER });
  assert.deepEqual(resolveIdToken('beast/agent4', ix), { kind: 'sandbox', machineId: 'beast', sandboxId: 'agent4' });
  assert.deepEqual(resolveIdToken('BEAST/agent4', ix), { kind: 'sandbox', machineId: 'beast', sandboxId: 'agent4' });
  assert.deepEqual(resolveIdToken('BEAST', ix), { kind: 'machine', machineId: 'beast' });
  assert.deepEqual(resolveIdToken('LothDesktop', ix), { kind: 'machine', machineId: 'lothdesktop' });
  assert.deepEqual(resolveIdToken('M5', ix), { kind: 'machine', machineId: 'm5' });
  assert.deepEqual(resolveIdToken('w6215', ix), { kind: 'request', id: 'w6215' });
});

test("Ben's sentence links the request, the worker, the machine and the sandbox, and nothing else", () => {
  const text = "A worker has started on w6215 (getting your Lens Scout portal on BEAST working again). It's worker b6c73b2b, running on BEAST in beast/agent4.";
  assert.deepEqual(linked(text), [
    ['w6215', 'request'],
    ['BEAST', 'machine'],
    ['b6c73b2b', 'session'],
    ['BEAST', 'machine'],
    ['beast/agent4', 'sandbox'],
  ]);
  assert.equal(idSegments(text, ix).map((s) => s.text).join(''), text, 'the segments give the text back');
});

test('unknown ids and ordinary words stay text', () => {
  for (const t of ['w9999', 'deadbeef', '12345678', 'beast/agent9', 'nobody/agent4', 'Beast', 'beastly', 'worker', 'the', 'W6215', 'r12'])
    assert.equal(resolveIdToken(t, ix), undefined, t);
  assert.deepEqual(linked('Commit deadbeef fixed w9999 on beast/agent9.'), []);
});

test('an 8-character prefix two sessions share links to neither, and a longer id that only starts like one is not a prefix', () => {
  assert.equal(resolveIdToken('0123abcd', ix), undefined);
  assert.deepEqual(resolveIdToken('0123abcd-0000-4000-8000-000000000002', ix), { kind: 'session', sessionId: '0123abcd-0000-4000-8000-000000000002' });
  // A 9-character or 7-character run is no session prefix.
  assert.deepEqual(linked('b6c73b2bf and b6c73b2 and b6c73b2b9'), []);
});

test('ids inside paths, URLs, instance names, numbers and longer words stay text', () => {
  const cases = [
    '/Users/x/beast/agent4/Assets',
    'https://example.com/w6215',
    'slot2@b6c73b2b',
    '#b6c73b2b',
    'file.w6215',
    'w6215-fix',
    'pre-BEAST',
    'beast/agent4/Library',
    'x:w6215',
  ];
  for (const c of cases) assert.deepEqual(linked(c), [], c);
  // Punctuation around an id is not part of it.
  assert.deepEqual(linked('(w6215), BEAST. "beast/agent4"; b6c73b2b\'s w12:'), [
    ['w6215', 'request'],
    ['BEAST', 'machine'],
    ['beast/agent4', 'sandbox'],
    ['b6c73b2b', 'session'],
    ['w12', 'request'],
  ]);
});

test('candidates are chosen by shape, so a message is wrapped once and each id resolves itself', () => {
  const words = new Set(['beast', 'BEAST']);
  for (const t of ['w1', 'deadbeef', WORKER, 'any/thing', 'BEAST']) assert.ok(isIdCandidate(t, words), t);
  for (const t of ['worker', 'Beast', 'deadbee', 'w', 'wx1']) assert.ok(!isIdCandidate(t, words), t);
});

// A rendered message's tree, as react-markdown's hast: a paragraph with text, inline code and a link, and a code block.
const tree = (): IdHastNode => ({
  type: 'root',
  children: [
    {
      type: 'element',
      tagName: 'p',
      children: [
        { type: 'text', value: 'Worker b6c73b2b on w6215, see ' },
        { type: 'element', tagName: 'code', children: [{ type: 'text', value: 'b6c73b2b w6215' }] },
        { type: 'text', value: ' and ' },
        { type: 'element', tagName: 'a', properties: { href: 'https://x' }, children: [{ type: 'text', value: 'w6215 in BEAST' }] },
        { type: 'element', tagName: 'strong', children: [{ type: 'text', value: 'beast/agent4' }] },
      ],
    },
    { type: 'element', tagName: 'pre', children: [{ type: 'element', tagName: 'code', children: [{ type: 'text', value: 'w6215 BEAST' }] }] },
  ],
});

const wrapKnown = (token: string): IdHastNode | undefined => (resolveIdToken(token, ix) ? { type: 'element', tagName: 'span', properties: { dataIdToken: token }, children: [{ type: 'text', value: token }] } : undefined);
const tokensIn = (n: IdHastNode): string[] => [...(n.properties?.dataIdToken ? [String(n.properties.dataIdToken)] : []), ...(n.children ?? []).flatMap(tokensIn)];
const textOf = (n: IdHastNode): string => (n.value ?? '') + (n.children ?? []).map(textOf).join('');

test('ids in text and emphasis are wrapped; ids inside code spans, code blocks and existing links are not', () => {
  const t = tree();
  const before = textOf(t);
  linkIdsInTree(t, wrapKnown);
  assert.deepEqual(tokensIn(t), ['b6c73b2b', 'w6215', 'beast/agent4']);
  assert.equal(textOf(t), before, 'the text reads the same');
  const p = t.children![0];
  assert.equal(p.children!.find((c) => c.tagName === 'code')!.children!.length, 1, 'the code span is untouched');
  assert.equal(p.children!.find((c) => c.tagName === 'a')!.children!.length, 1, 'the link is untouched');
});

test('a tree with no known ids is left as it was', () => {
  const t: IdHastNode = { type: 'root', children: [{ type: 'element', tagName: 'p', children: [{ type: 'text', value: 'Nothing to see in deadbeef or w9999.' }] }] };
  const kids = t.children![0].children;
  linkIdsInTree(t, wrapKnown);
  assert.equal(t.children![0].children, kids, 'the same children, not a copy');
});
