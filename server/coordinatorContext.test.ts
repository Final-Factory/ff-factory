import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { asOnLinuxCi, withCoordinators } from '../scripts/coordinatorContext.ts';
import { ALWAYS_LOADED } from './belts.ts';
import { deferredToolsLine } from './toolManifest.ts';
import { RULE_TOPICS, type Agents, type RuleTopic } from './agents.ts';
import { REACTION_MEANINGS } from '../shared/replies.ts';
import type { Requester, SessionInfo } from '../shared/types.ts';

/**
 * What a coordinator carries in every call (w1158, docs/orchestrators.md "What a coordinator's context costs"). In
 * spend_report for 2026-10-10..12 the dispatcher and the personal orchestrators were about $5.8k of the top-20 requests'
 * $6.9k, and their base context (prompt and tools) was 48,200 input tokens per call for the dispatcher (measured). The
 * rarely needed rules moved to read_rules topics and the rarely used tools behind ToolSearch; nothing was dropped.
 */

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const SAM: Requester = { userId: 'sam', displayName: 'Sam' };

const promptOf = (agents: Agents, info: SessionInfo) => (agents.orchestratorOptions(info) as { systemPrompt: { append: string } }).systemPrompt.append;
const kindOf = (kinds: [string, SessionInfo][], k: string) => kinds.find(([name]) => name.startsWith(k))![1];

/** Which coordinator reads which topic: the dispatcher's are about placing work, the person's about their chat. */
const TOPICS: Record<'dispatcher' | 'personal', readonly RuleTopic[]> = {
  dispatcher: ['ffbox', 'intake', 'release', 'machines', 'ui'],
  personal: ['ffbox', 'machines', 'reactions', 'ui', 'builds'],
};

test('w1158: every read_rules topic is named in the brief of each coordinator that reads it, and has its text', async () => {
  assert.deepEqual([...new Set([...TOPICS.dispatcher, ...TOPICS.personal])].sort(), [...RULE_TOPICS].sort(), 'every topic is somebody\'s');
  await withCoordinators((agents, kinds) => {
    for (const [kind, info] of kinds) {
      const role = kind === 'dispatcher' ? 'dispatcher' : 'personal';
      const owner = role === 'personal' ? agents.orchestrators.ownerOf(info) : undefined;
      const prompt = promptOf(agents, info);
      for (const topic of TOPICS[role]) {
        assert.ok(prompt.includes(`\`read_rules ${topic}\``), `${kind}: the brief says when to read ${topic}`);
        assert.ok(agents.rulesText(topic, owner).length > 400, `${kind}: ${topic} has its text`);
      }
      // The brief tells it how the deferred tools and the topics work.
      assert.ok(prompt.includes(deferredToolsLine(role)), `${kind}: how to load a deferred tool or a group (w1163)`);
      assert.match(prompt, /read the topic before you act in that case; it binds like this brief/);
    }
    // read_rules answers the caller: a person's topics name their person.
    assert.match(agents.rulesText('reactions', BEN), /a 👍 or ✅ on your own message that asks Ben a yes-or-no question/);
  });
});

test("w1399: the UI-stills topic holds the look-first rule, the critic report and Ben's words, for both coordinators", async () => {
  await withCoordinators((agents) => {
    for (const text of [agents.rulesText('ui'), agents.rulesText('ui', BEN)]) {
      assert.ok(text.includes('"you make bad UI mistakes constantly"'), "Ben's words");
      assert.ok(text.includes(`"the active stop color is bleeding into a bunch of the panel's elements, it looks bad, like its washing everything out"`));
      assert.match(text, /Open every still yourself before you read the worker's words about it/);
      assert.match(text, /critic\.md from a fresh ff-agents ui-critic/);
      assert.match(text, /None, or one left open: send it back with what is missing; do not relay\./);
      assert.match(text, /Colour: and Shape: lines/);
      assert.match(text, /2 or 3 clearly different options/);
    }
    assert.match(agents.rulesText('ui', BEN), /show Ben a UI still/);
    assert.match(agents.rulesText('ui'), /A brief for UI work says: build from the game's own components/);
  });
});

test('w1158: the rules moved out of the briefs keep their words and their w-numbers', async () => {
  await withCoordinators((agents) => {
    const d = (t: RuleTopic) => agents.rulesText(t);
    const p = (t: RuleTopic) => agents.rulesText(t, BEN);
    // Machines (w855, w605, w887, w626, w896, w935, w936), for both kinds.
    for (const text of [d('machines'), p('machines')]) {
      assert.ok(text.includes('w855, lothsahn, 2026-10-10: "don\'t ask ben to run installers.  Update your instructions.  Stop doing that.  When we say update the machines, do the update, including installers if necessary"'));
      assert.match(text, /An update never needs a drain or a wait \(w605/);
      assert.match(text, /After a verified portal deploy FF Factory updates every worker-root machine's daemon by itself .* w887/);
      assert.match(text, /w626/);
      assert.match(text, /w896: "in general we should only be clearing data in the install folder for the worker"/);
      assert.match(text, /w935, Ben: "You can close Unity\."/);
      assert.match(text, /w936/);
    }
    assert.match(d('machines'), /decide_work note the requester's orchestrator, which has the ops worker, with the exact step: "ops_worker machine_update, machine biscuit, max_sandboxes 3, work_id <the request>"/);
    assert.match(p('machines'), /call ops_worker machine_update once per machine, one after another/);
    assert.match(agents.rulesText('machines', SAM), /file it \(request_work\), and Lothsahn's or Ben's own orchestrator runs it through the ops worker/, 'a member has no ops worker');
    assert.match(p('machines'), /The grant is a field on the request, never text in a brief, and only Ben's own turn sets it/);
    // Replies and reactions (w866, w1039).
    assert.ok(p('reactions').includes(REACTION_MEANINGS));
    assert.ok(p('reactions').includes('(w1039, Ben: "please count my thumbs up as my words")'));
    assert.match(p('reactions'), /It covers only what ONE sentence of that message proposes, the request and the action together/);
    assert.match(p('reactions'), /Deleting, settings, memory writes and new filings still need their typed words/);
    // Intake: Lothsahn's desync PR policy, FFBox's branch prefix, send_to_ffbox.
    assert.match(d('intake'), /\*\*FFBox desync diagnoses and their PRs\*\* \(Lothsahn's standing policy, 2026-10-04; tagged "desync PR policy"\)/);
    assert.match(d('intake'), /1, it only changes what a desync report holds.* 2, it fixes a desync in the game code.* 3, it changes what is captured during play/);
    assert.match(d('intake'), /Never merge a class 3 PR with a measured cost yourself, and never brief a worker to skip the classification\./);
    assert.match(d('intake'), /goes on a `ffbox-f\/<name>` branch, not `sandbox\/<name>`/);
    assert.match(d('intake'), /Anything CPU-only may go to FFBox with send_to_ffbox when that is on/);
    // Releases (w901, w1137).
    assert.match(d('release'), /post the patch notes in #dev-patch-notes once live/);
    assert.match(d('release'), /post_as_max, which has FFBox post as Max \(w901\)/);
    assert.match(d('release'), /the branch it LANDED on .* and the #dev-patch-notes message link/);
    // FFBox messages to a person's orchestrator (w831, w852).
    assert.match(p('ffbox'), /A message from Ben that starts `\[via FFBox: Ben's own message in …\]` is Ben's own words/);
    assert.match(p('ffbox'), /Answer either with reply_to_ffbox/);
    assert.ok(!d('ffbox').includes('[via FFBox:'), "the dispatcher has no person's chat");
  });
});

test('w1158: each coordinator loads its everyday tools in every call and finds the rest with ToolSearch', async () => {
  await withCoordinators((agents, kinds) => {
    for (const [role, info] of [['dispatcher', kindOf(kinds, 'dispatcher')], ['personal', kindOf(kinds, 'owner (Ben)')]] as const) {
      const defs = agents.orchestratorToolDefs(info);
      const names = new Set(defs.map((t) => t.name));
      for (const name of ALWAYS_LOADED[role]) assert.ok(names.has(name), `${role}: ${name} is in its belt`);
      for (const t of defs) assert.equal(!!t._meta?.['anthropic/alwaysLoad'], ALWAYS_LOADED[role].has(t.name), `${role}: ${t.name}`);
      assert.ok(defs.length > ALWAYS_LOADED[role].size + 10, `${role}: most tools are deferred`);
      const o = agents.orchestratorOptions(info) as { tools: string[]; allowedTools: string[] };
      assert.ok(o.tools.includes('ToolSearch') && o.allowedTools.includes('ToolSearch'), `${role}: ToolSearch loads the deferred ones`);
      assert.ok(!o.tools.includes('Bash'), `${role}: still no shell`);
    }
  });
});

test('w1158: what a coordinator carries in every call stays within its budget', async () => {
  // Characters (exact), with this machine's paths as CI's Linux runner has them (asOnLinuxCi, w1758); the API's own count was ~2.9 characters a token for this text. Before w1158: the dispatcher's
  // prompt 37,004 characters and every one of its 51 tools in full, 84,200 (measured).
  // w1399 (Ben, 2026-10-16: "you make bad UI mistakes constantly") added the one-line UI-stills trigger to both briefs; the
  // owner's brief measured 26,180 characters with it (Lothsahn's name, the longest, about 100 times), so the cap moved from
  // 26,000 to 26,500. The rule itself is the read_rules ui topic.
  // w1602 (Ben: "when you ask me about visual things you have to include the previews") added the one-line rule that a
  // visual question carries its previews in the card; the owner's brief measured 26,629, so the cap moved to 26,750.
  // w1691 (lothsahn: "Tell the agents they can still write performance tests but they should all be flagged performance if
  // they check timings") added one line on Performance-tagged game tests to both briefs; the dispatcher's measured 27,093, so the cap moved to 27,100.
  // w1692 (lothsahn: "Not windows by default, any OS.  Being particular about a machine or OS limits the fleet we can use")
  // added one line on where a determinism check runs to both briefs; the dispatcher's measured 27,428, so the cap moved to 27,450.
  // w1717 (lothsahn: "one row that allows me to override my default pool for another operator (ben) and then all my billing goes
  // there") added one line pointing a personal orchestrator at set_pool; the owner's brief measured 27,514, so the cap moved to 27,550.
  // w1748 (lothsahn: "Please make it so you can delete memory files") added one sentence on delete_memory to every brief's memory
  // rules (91 characters, trimmed from 280); Lothsahn's own measured 27,606, so the cap moved to 27,650.
  // w1770 (Ben: "I mean, you can check the code, but it just seems like you didn't investigate at all. Like, if you're unsure,
  // then do the check.") added the one-line trigger for the read_rules builds topic to a person's orchestrator's brief (the
  // rule itself is the topic); the owner's brief measured 27,898, so the cap moved to 27,900.
  // w1812 (Ben: "i already answered this why are you asking me in the waiting on input for this still") added one sentence
  // to the [needs you] rule: read the notes of the request and its worker's other requests before asking (cut from 560
  // characters to 240; ask_person's refusal carries the rest); the owner's brief measured 28,140, so the cap moved to 28,150.
  // w1955 (lothsahn: "Why was I being shown old cards that were decided?") added one sentence to the ask_person rule: a card answered
  // in typed words is closed with close_question that turn (69 characters). Main had grown to 28,243 before it (over the cap, which
  // the pull request gate does not run); the owner's brief measured 28,312, so the cap moved to 28,350.
  const PROMPT_MAX = 28_350;
  // w1163: the always-loaded sets now follow measured use (docs/tool-manifest.md); the dispatcher's is 23,436 characters
  // since w1159 gave list_work, list_sandboxes, list_machines and agent_transcript their output options. w1597 gave decide_work
  // its questions (one plain question per decision with its answers, as the person's card asks them; Ben, 2026-10-19: "just ask
  // the question clearly, give me the option selections and thats it"): the dispatcher's measured 24,348, so the cap moved to 24,500.
  // w1863 (lothsahn: "Why did they hang if the m5 was free?") gave decide_work queue its leg for a named computer beside the
  // request's own worker, and drop_leg (trimmed from 450 characters to 170): the dispatcher's measured 24,672, so the cap moved to 24,700.
  const ALWAYS_LOADED_MAX = 24_700;
  await withCoordinators((agents, kinds) => {
    for (const [kind, info] of kinds) {
      const prompt = asOnLinuxCi(promptOf(agents, info)).length;
      const tools = agents
        .orchestratorToolDefs(info)
        .filter((t) => t._meta?.['anthropic/alwaysLoad'])
        .reduce((n, t) => n + t.name.length + t.description.length + JSON.stringify(z.toJSONSchema(z.object(t.inputSchema))).length, 0);
      assert.ok(prompt <= PROMPT_MAX, `${kind}: its brief is ${prompt} characters, over ${PROMPT_MAX}: move a rarely needed rule to a read_rules topic, or cut duplication`);
      assert.ok(tools <= ALWAYS_LOADED_MAX, `${kind}: its always-loaded tools are ${tools} characters, over ${ALWAYS_LOADED_MAX}: defer one (server/toolManifest.ts) or shorten it`);
    }
  });
});
