import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { redactTokenShapes } from '../shared/secretShapes.ts';
import { redactSecrets, redactValue } from './secrets.ts';
import { redactFileText } from './scrubSecrets.ts';

// w5526 (security audit w5452, finding 17): JWTs, AWS access keys, Slack tokens, Bearer credentials and passwords in URLs
// were masked only in portal_logs; now the shared set (shared/secretShapes.ts) masks them on every path: transcripts,
// reports, the data-folder scrub, the journal. Fakes built at run time, so no secret scanner takes them for real ones.
const b64url = (s: string) => Buffer.from(s).toString('base64url');
const JWT = `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url('{"sub":"1234567890","name":"fake"}')}.${'FaKeSiGnAtUrE_-'.repeat(3)}yVC9`;
const AKIA = `${'AKIA'}FAKE${'2345'.repeat(2)}EXYZ`;
const ASIA = `${'ASIA'}FAKE${'6789'.repeat(2)}EXYZ`;
const XOXB = `${'xox'}b-1234567890-1234567890-${'FaKe'.repeat(6)}yVC9`;
const XOXP = `${'xox'}p-2345678901-2345678901-2345678901-${'fake'.repeat(8)}`;
const BEARER_TOKEN = `fake0${'AbCd'.repeat(6)}.x_y-z~yVC9`;
const URL_PASS = 'hunter2-fake-pass';
const URL_USER_TOKEN = `${'u1'.repeat(15)}yVC9`;

/** Each new shape: where it sits in a line, and the secret that must not survive. */
const POSITIVE: [string, string][] = [
  [`session cookie value ${JWT} expired`, JWT],
  [`"id_token":"${JWT}"`, JWT],
  [`aws_access_key_id = ${AKIA}`, AKIA],
  [`AWS_ACCESS_KEY_ID=${ASIA}`, ASIA],
  [`slack bot ${XOXB}`, XOXB],
  [`{"token":"${XOXP}"}`, XOXP],
  [`curl -H "Authorization: Bearer ${BEARER_TOKEN}" https://api.example.com`, BEARER_TOKEN],
  [`bearer ${BEARER_TOKEN}`, BEARER_TOKEN],
  [`BEARER ${BEARER_TOKEN}`, BEARER_TOKEN],
  [`git clone https://ben:${URL_PASS}@github.com/Final-Factory/x.git`, URL_PASS],
  [`DATABASE_URL=postgres://admin:${URL_PASS}@db.internal:5432/app`, URL_PASS],
  [`"url":"https://x-access-token:${URL_PASS}@github.com/a/b"`, URL_PASS],
  [`remote https://${URL_USER_TOKEN}@github.com/a/b`, URL_USER_TOKEN],
];

test('w5526: every new shape is masked by the shared redactor, and masking it again changes nothing', () => {
  for (const [line, secret] of POSITIVE) {
    const once = redactTokenShapes(line);
    assert.ok(!once.includes(secret), `still there: ${once}`);
    assert.match(once, /\[redacted/, line);
    assert.equal(redactTokenShapes(once), once, `not idempotent: ${once}`);
    // redactSecrets (every store, the scrub) gets it too
    assert.equal(redactSecrets(line), once);
  }
});

test('w5526: what stays, by kind and last four, so a reader knows which credential it was', () => {
  assert.equal(redactTokenShapes(`x ${JWT} y`), 'x [redacted JWT …yVC9] y');
  assert.equal(redactTokenShapes(AKIA), 'AKIA[redacted …EXYZ]');
  assert.equal(redactTokenShapes(XOXB), 'xoxb-[redacted …yVC9]');
  assert.equal(redactTokenShapes(`Authorization: Bearer ${BEARER_TOKEN}`), 'Authorization: Bearer [redacted …yVC9]');
  assert.equal(redactTokenShapes(`https://ben:${URL_PASS}@github.com/a`), 'https://ben:[redacted]@github.com/a');
  assert.equal(redactTokenShapes(`https://${URL_USER_TOKEN}@github.com/a`), 'https://[redacted …yVC9]@github.com/a');
});

test('w5526: commits, ordinary URLs, prose and base64 game data stay unmasked', () => {
  const keep = [
    // commit SHAs, short and long, alone and in a URL
    'Merge 590e1332a1b7c0d6e8f1a2b3c4d5e6f708192a3b into master',
    'https://github.com/Final-Factory/ff-factory/commit/590e1332a1b7c0d6e8f1a2b3c4d5e6f708192a3b',
    '268a816673 Merge pull request #4328',
    // URLs without credentials
    'https://github.com/Final-Factory/ff-factory/pull/1152',
    'ssh://git@github.com/Final-Factory/ff-factory.git',
    'git@github.com:Final-Factory/ff-factory.git',
    'http://localhost:8080/api/health?x=1',
    'http://[::1]:3000/',
    'https://example.com/@someone/post',
    'https://fff.example/files/a:b/c@d',
    'mailto:dev@example.com',
    'postgres://localhost:5432/app',
    'https://user@example.com/x',
    // prose and code about the shapes
    'The API takes Bearer authentication: send the Bearer token header.',
    'Bearer abc',
    'const header = `Bearer ${token}`;',
    'Authorization: Bearer <token>',
    'xoxo-hugs and xoxb-template-name are not tokens',
    'AKIA is the prefix of an AWS access key id; AKIA123 is too short',
    'eyJhbGciOiJIUzI1NiJ9 alone is a JWT header, not a token',
    'the version is 1.2.3.4 and the ids are a.b.c',
  ];
  for (const l of keep) assert.equal(redactTokenShapes(l), l, l);

  // base64 game data (a save's blob, a texture): random bytes, deterministic, in base64 and base64url, wrapped and not
  const rnd = crypto.createHash('sha512');
  const bytes: Buffer[] = [];
  for (let i = 0; i < 256; i++) bytes.push(rnd.copy().update(String(i)).digest());
  const blob = Buffer.concat(bytes);
  for (const s of [blob.toString('base64'), blob.toString('base64url'), blob.toString('base64').replace(/(.{76})/g, '$1\n')]) {
    assert.equal(redactTokenShapes(s), s, 'base64 game data was masked');
  }
  // a JSON save fragment with base64 fields and an ordinary object id
  const save = JSON.stringify({ version: '0.50.0.45', chunk: blob.subarray(0, 600).toString('base64'), id: '0123456789abcdef0123456789abcdef' });
  assert.equal(redactTokenShapes(save), save);
});

test('w5526: the data-folder scrub masks the new shapes in a transcript line, JSON-escaped included', () => {
  const event = { type: 'user', message: { content: `ran:\n  curl -H "Authorization: Bearer ${BEARER_TOKEN}"\n${JWT}\n${AKIA}\n${XOXB}\nhttps://ben:${URL_PASS}@x.example/` } };
  const { text, n } = redactFileText('s.jsonl', JSON.stringify(event) + '\n');
  assert.ok(n >= 5, `masked ${n}`);
  for (const [, secret] of POSITIVE) assert.ok(!text.includes(secret), `scrub left ${secret.slice(-4)}`);
  assert.deepEqual(redactValue(event).message.content.includes(JWT), false);
});
