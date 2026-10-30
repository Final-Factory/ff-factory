import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMediaTrouble, mediaTroubleLine } from '../shared/mediaTrouble.ts';
import { tempFolderSession } from './cleanup.ts';

// w2576: a page tells the portal which stills it could not show, so a card's blank picture is read from the journal.

test('a page report is checked and clipped: no kind or no src is not one, numbers are whole and never negative', () => {
  assert.equal(cleanMediaTrouble(undefined), undefined);
  assert.equal(cleanMediaTrouble({ kind: 'error' }), undefined);
  assert.equal(cleanMediaTrouble({ kind: 'gone', src: '/api/image?path=x' }), undefined);
  const t = cleanMediaTrouble({ kind: 'blank', src: `/api/image?path=a\nb${'x'.repeat(900)}`, surface: 'card', page: '#/dispatcher/waiting?x=1', requests: 2.6, status: -3, bytes: 'many', complete: 'yes' });
  assert.ok(t);
  assert.equal(t.src.length, 600);
  assert.ok(!t.src.includes('\n'));
  assert.equal(t.page, '#/dispatcher/waiting');
  assert.equal(t.requests, 3);
  assert.equal(t.status, 0);
  assert.equal(t.bytes, undefined);
  assert.equal(t.complete, undefined);
});

test('the journal line names the person, the surface, the file with its session and what the browser saw', () => {
  const line = mediaTroubleLine('ben', { surface: 'text', kind: 'error', src: '/api/image?path=%2Fsrv%2Ffff%2Freview%2Fw1%2Fa.png&session=abcd1234', page: '#/dispatcher/waiting', requests: 1, status: 400, bytes: 35, ms: 2, complete: true, naturalWidth: 0 }, 'Chrome');
  assert.equal(line, "[media] ben's page could not show a still (error) in text on #/dispatcher/waiting: /srv/fff/review/w1/a.png (session abcd1234); requests 1, last: status 400, 35 B, 2 ms; complete true, width 0; Chrome");
  assert.match(mediaTroubleLine('ben', { surface: 'card', kind: 'blank', src: '/api/image?path=x', requests: 0 }, ''), /\(blank 15s on screen\) in card on \?: x; never requested;/);
});

test("a worker's temp folder names its session, on Windows and POSIX paths; other paths name none", () => {
  assert.equal(tempFolderSession('F:\\ffw\\tmp\\ffa-988885c9\\shots\\spire.png'), '988885c9');
  assert.equal(tempFolderSession('/home/x/ffw/tmp/ffa-1db3f09b/a.png'), '1db3f09b');
  assert.equal(tempFolderSession('/srv/fff/review/w2198/spire.png'), undefined);
  assert.equal(tempFolderSession('F:/ffw/tmp/ffa-988885c9'), undefined);
});
