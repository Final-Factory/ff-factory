import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CENSUS_GRACE_MS, CENSUS_REMIND_MS, CensusWatch, censusOf, describeCounted, type AgentCensus, type PortalCounted, type PortalSeen } from './agentCensus.ts';
import { totalAgentsRefusal } from '../machine/sandboxes.ts';
import { AGENT_CAP_REFUSAL } from './machines.ts';

// beast, 2026-11-26: its daemon adopted these at 06:19:01Z (daemon.log lines 18801-18808, as quoted in w5938's worker
// f305bf10's transcript); six mid-turn. lothsahn stopped 847ebd50 (w5891) and d732483b (w5869) at 06:28:45; placement
// counted beast at 2 of 6 at 06:35:09 and its daemon refused at 06:37:34.
const beast: AgentCensus = {
  midTurn: [
    { id: '11a84ee9', sandbox: 'slot1', status: 'running', live: true },
    { id: '716b6111', sandbox: 'slot2', status: 'running', live: true },
    { id: '828bacfa', sandbox: 'slot5', status: 'running', live: true },
    { id: '847ebd50', sandbox: 'slot4', status: 'running', live: true },
    { id: '9a8691c5', sandbox: 'slot6', status: 'running', live: true },
    { id: 'd732483b', sandbox: 'slot3', status: 'running', live: false },
  ],
};
const portal: PortalCounted[] = [
  { id: '11a84ee9', sandbox: 'slot1', status: 'running', live: true, starting: false },
  { id: '828bacfa', sandbox: 'slot5', status: 'running', live: true, starting: false },
  { id: 'c1e9dd0c', sandbox: 'slot4', status: 'idle', live: false, starting: true },
];
const seen = (id: string): PortalSeen => (id === '847ebd50' || id === 'd732483b' ? { machine: 'beast', status: 'stopped', live: false } : id === '9a8691c5' ? { machine: 'beast', status: 'idle', live: true } : id === '716b6111' ? { machine: 'biscuit', status: 'running', live: true } : undefined);

test('w5972: a refusal at an agent cap names the agents it counted, and the portal still reads it as a capacity wait', () => {
  const why = totalAgentsRefusal(6, { maxAgents: 6 }, beast.midTurn)!;
  assert.match(why, /already 6 agents running in this machine's sandboxes \(max_sandbox_agents 6\); stop one first; counted: 11a84ee9 \(slot1, running\), /);
  assert.match(why, /d732483b \(slot3, running, no process\)/);
  assert.match(why, AGENT_CAP_REFUSAL, 'the portal requeues it as before (w3597)');
  assert.equal(totalAgentsRefusal(6, { maxAgents: 6 }), "already 6 agents running in this machine's sandboxes (max_sandbox_agents 6); stop one first", 'without the list: the old words');
  // The daemon's other two refusals keep the words the portal matches, with the list after them.
  assert.match(`already 2 agents mid-turn in sandbox slot3 (max_agents_per_sandbox); counted: ${describeCounted(beast.midTurn.slice(0, 2))}`, AGENT_CAP_REFUSAL);
  assert.match(`already 6 agents mid-turn on this machine, in its sandboxes and standing agents together (its agent cap 6); counted: ${describeCounted(beast.midTurn)}`, AGENT_CAP_REFUSAL);
});

test('w5972: describeCounted names standing agents, shortens ids and caps a long list', () => {
  assert.equal(describeCounted([{ id: 'abcdef0123456789', status: 'waiting_permission', live: true }]), 'abcdef01 (standing, waiting_permission)');
  assert.equal(describeCounted([]), 'none');
  const many = Array.from({ length: 15 }, (_, i) => ({ id: `s${i}`, sandbox: 'x', status: 'running', live: true }));
  assert.match(describeCounted(many), / and 3 more$/);
});

test('w5972: censusOf takes a well-formed census and drops what is not one', () => {
  assert.equal(censusOf(undefined), undefined, 'a daemon before w5972 sends none');
  assert.equal(censusOf({ midTurn: 'x' }), undefined);
  assert.deepEqual(censusOf({ midTurn: [{ id: 'a', status: 'running', live: true }, { id: 7 }, null, { id: '', status: 'x' }, { id: 'b', sandbox: 's1', status: 'starting' }] }), {
    midTurn: [
      { id: 'a', status: 'running', live: true },
      { id: 'b', sandbox: 's1', status: 'starting', live: false },
    ],
  });
});

test('w5972: the portal warns of a lasting count mismatch by session id, once, and says when the counts agree again', () => {
  const w = new CensusWatch();
  const t0 = Date.parse('2026-11-26T06:35:00Z');
  assert.equal(w.note('beast', beast, portal, seen, t0), undefined, 'first report: could be in flight');
  assert.equal(w.note('beast', beast, portal, seen, t0 + 15_000), undefined, 'inside the grace');
  const line = w.note('beast', beast, portal, seen, t0 + CENSUS_GRACE_MS)!;
  assert.ok(line, 'warned after the grace and two reports');
  assert.match(line, /^agent count: beast's daemon counts 6 agent\(s\) mid-turn \(.*\), the portal 3 \(2 reported mid-turn, which placement counts, and 1 sent, not yet reported\)/);
  assert.match(line, /counted by its daemon only: 716b6111 \(slot2, running\) \[on biscuit for the portal\]; 847ebd50 \(slot4, running\) \[portal: stopped, no process\]; 9a8691c5 \(slot6, running\) \[portal: idle\]; d732483b \(slot3, running, no process\) \[portal: stopped, no process\]/);
  assert.match(line, /counted by the portal only: c1e9dd0c \(slot4, idle, no process\) \[sent, not yet reported\]/);
  assert.match(line, /warn only/);
  assert.equal(w.note('beast', beast, portal, seen, t0 + CENSUS_GRACE_MS + 15_000), undefined, 'the same mismatch is not warned again at once');
  assert.ok(w.note('beast', beast, portal, seen, t0 + CENSUS_GRACE_MS + CENSUS_REMIND_MS), 'reminded while it lasts');
  assert.equal(w.lastOf('beast')?.census, beast, 'the last census is kept for the enforce stage');
  const agree: PortalCounted[] = beast.midTurn.map((a) => ({ ...a, starting: false }));
  assert.match(w.note('beast', beast, agree, seen, t0 + 2 * CENSUS_REMIND_MS)!, /agree again: 6 agent\(s\) mid-turn/);
  assert.equal(w.note('beast', beast, agree, seen, t0 + 2 * CENSUS_REMIND_MS + 15_000), undefined, 'said once');
});

test('w5972: a difference that clears within the grace (a turn just sent or ended) is never warned of', () => {
  const w = new CensusWatch();
  const t0 = 1_000_000;
  const one: AgentCensus = { midTurn: [{ id: 'a', sandbox: 's1', status: 'running', live: true }] };
  assert.equal(w.note('m5', one, [], () => undefined, t0), undefined);
  assert.equal(w.note('m5', one, [{ id: 'a', sandbox: 's1', status: 'running', live: true, starting: false }], () => undefined, t0 + 15_000), undefined);
  // It comes back later: its clock starts again, so one report after a long gap is not yet lasting.
  assert.equal(w.note('m5', one, [], () => undefined, t0 + 10 * CENSUS_GRACE_MS), undefined);
  w.forget('m5');
  assert.equal(w.lastOf('m5'), undefined, 'a link drop forgets it');
});
