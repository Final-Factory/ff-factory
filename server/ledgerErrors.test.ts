import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_RESUMES, doneCriteriaOf, errorKey, notDoneReason, troubleDecision, turnTroubleOf, type TurnTrouble } from './ledgerRules.ts';
import type { SessionInfo, WorkErrorHandled } from '../shared/types.ts';
import { W1829_AT, W1829_REQUEST, W1829_WORKER } from './ledgerSweep.fixtures.ts';

// w1870's rules (server/ledgerRules.ts): how a worker's last turn ended, and what the ledger cleanup does about it instead of
// closing the request. The sweep's own tests (server/ledgerSweep.test.ts, "w1870") run them on a real ledger.

const NOW = Date.parse('2026-10-23T16:00:00.000Z');
const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
const s = (over: Partial<SessionInfo>) => ({ status: 'idle', lastActivityAt: at(30), lastResultAt: at(30), ...over }) as SessionInfo;

test('w1870: turnTroubleOf tells an interrupt from an error, and an error a person must clear', () => {
  // w1829: the dispatcher's interrupt ended the turn in error_during_execution.
  assert.deepEqual(turnTroubleOf(W1829_WORKER as SessionInfo, []), { kind: 'interrupt', reason: 'its turn was interrupted on purpose (error_during_execution)', turnAt: W1829_AT.error });
  // A host session's interrupt leaves "Interrupted." in its transcript.
  assert.equal(turnTroubleOf(s({ lastResult: 'stopped: error_during_execution' }), ['Interrupted.'])?.kind, 'interrupt');
  const err = turnTroubleOf(s({ lastResult: 'stopped: error_during_execution' }), ['API Error: 500 Internal server error', 'stopped: error_during_execution']) as Extract<TurnTrouble, { kind: 'error' }>;
  assert.deepEqual([err.kind, err.cause, err.reason, err.needs], ['error', 'error', 'its last turn ended in error_during_execution: API Error: 500 Internal server error', undefined]);
  assert.equal(turnTroubleOf(s({ lastResult: 'stopped: error_max_turns' }), [])?.reason, 'its last turn ended in error_max_turns');
  const login = turnTroubleOf(s({ lastResult: 'stopped: error_during_execution' }), ['Not logged in · Please run /login']) as Extract<TurnTrouble, { kind: 'error' }>;
  assert.equal(login.needs, 'a login');
  const perm = turnTroubleOf(s({ lastResult: 'stopped: error_during_execution' }), [], ['refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` permission']) as Extract<TurnTrouble, { kind: 'error' }>;
  assert.equal(perm.needs, 'a permission');
  // A failed tool's own "connection refused" is no refused tool.
  assert.equal((turnTroubleOf(s({ lastResult: 'stopped: error_during_execution' }), [], ['curl: (7) Failed to connect: Connection refused']) as Extract<TurnTrouble, { kind: 'error' }>).cause, 'error');
  assert.equal((turnTroubleOf(s({ status: 'stopped', statusDetail: 'You hit your usage limit · resets 3pm' }), []) as Extract<TurnTrouble, { kind: 'error' }>).cause, 'limit');
  assert.equal((turnTroubleOf(s({ status: 'error', statusDetail: 'the agent host exited with code 1' }), []) as Extract<TurnTrouble, { kind: 'error' }>).cause, 'crash');
  // A turn that ended with a report, and a worker stopped on purpose after a normal turn, are no trouble.
  assert.equal(turnTroubleOf(s({ lastResult: 'w1: still open: blocked on CI' }), []), undefined);
  assert.equal(turnTroubleOf(s({ status: 'stopped', stoppedOnPurpose: true, lastResult: 'Merged.\nDONE: w1' }), []), undefined);
});

test('w1870: troubleDecision resumes an error, escalates the same error after a resume, a refusal or a person-only error, and re-places an interrupt', () => {
  const t = (reason: string, turnAt = at(30), extra: Partial<Extract<TurnTrouble, { kind: 'error' }>> = {}): TurnTrouble => ({ kind: 'error', cause: 'error', reason, turnAt, ...extra });
  const resumed = (error: string, resumes = 1): WorkErrorHandled => ({ turnAt: at(90), how: 'resumed', at: at(80), error, resumes });
  const active = { status: 'active' as const };
  assert.deepEqual(troubleDecision(active, t('its last turn ended in error_during_execution'), undefined, NOW), { do: 'resume' });
  assert.equal(troubleDecision(active, t('its last turn ended in error_during_execution'), resumed('its last turn ended in error_during_execution'), NOW).do, 'escalate');
  // The same error in other numbers is the same error.
  assert.equal(errorKey('its last turn ended in error_during_execution: API Error: 500 {"type":"error"}'), errorKey('its last turn ended in error_during_execution: API Error: 529 overloaded'));
  // A different error after a resume is resumed again, up to ERROR_RESUMES.
  assert.equal(troubleDecision(active, t('its last turn ended in error_max_turns'), resumed('its last turn ended in error_during_execution'), NOW).do, 'resume');
  assert.equal(troubleDecision(active, t('its last turn ended in error_max_turns'), resumed('its last turn ended in error_during_execution', ERROR_RESUMES), NOW).do, 'escalate');
  assert.equal(troubleDecision(active, t('a refused tool', at(30), { cause: 'refused' }), undefined, NOW).do, 'escalate');
  const needs = troubleDecision(active, t('its last turn ended in error_during_execution: Not logged in', at(30), { needs: 'a login' }), undefined, NOW);
  assert.deepEqual([needs.do, needs.do === 'escalate' && needs.why], ['escalate', 'it needs a login, which only a person can give']);
  // Handled already, fresh, or queued for the dispatcher.
  assert.equal(troubleDecision(active, t('x', at(90)), resumed('x'), NOW).do, 'none');
  assert.equal(troubleDecision(active, t('x', at(2)), undefined, NOW).do, 'wait');
  assert.equal(troubleDecision({ status: 'queued' }, t('x'), undefined, NOW).do, 'leave');
  const interrupt: TurnTrouble = { kind: 'interrupt', reason: 'its turn was interrupted on purpose (error_during_execution)', turnAt: W1829_AT.error };
  assert.equal(troubleDecision({ status: 'queued' }, interrupt, undefined, Date.parse(W1829_AT.closed)).do, 'leave', 'w1829: queued for BEAST by the dispatcher');
  assert.equal(troubleDecision(active, interrupt, undefined, Date.parse(W1829_AT.closed)).do, 'wait', 'minutes old: the dispatcher may be placing it');
  assert.equal(troubleDecision(active, interrupt, undefined, NOW).do, 'replace');
});

test("w1870: a request's done criteria, and whether its worker's last report is a DONE", () => {
  assert.equal(doneCriteriaOf(W1829_REQUEST.brief!), "- The change is merged on green CI and deployed by the normal auto-deploy.\n- On a real machine with at least two other editors busy, a timed leg's quiet gate opens with no NOGATE.\n- Editors resume normally afterwards: show one compiling or playing again.\n- A ticket holder killed mid-leg still releases everything.");
  assert.equal(doneCriteriaOf('**Done when:** the test passes.\n\n**Constraints:** none'), 'the test passes.');
  assert.equal(doneCriteriaOf('Fix the belts.'), undefined);
  const w = { id: 'w5' };
  assert.equal(notDoneReason(w, []), undefined, 'no worker: a person\'s own PR');
  assert.equal(notDoneReason(w, [s({ id: 's1', lastResult: 'Merged.\nDONE: w5' })]), undefined);
  assert.match(notDoneReason(w, [s({ id: 's1', lastResult: 'Merged; all done.' })])!, /^its latest worker s1's last report is not a DONE for w5 \("Merged; all done\."\)$/);
  assert.match(notDoneReason({ id: 'w5', reopenedAt: at(10) }, [s({ id: 's1', lastResult: 'Merged.\nDONE: w5', lastResultAt: at(20) })])!, /not a DONE/, 'a DONE from before a reopen');
  assert.equal(notDoneReason({ id: 'w5', done: { s1: { at: at(30), report: 'DONE: w5' } } }, [s({ id: 's1', lastResult: 'Merged.' })]), undefined, 'the DONE the ledger recorded from that report');
});
