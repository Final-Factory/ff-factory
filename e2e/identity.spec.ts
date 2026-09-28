import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request as pwRequest, type APIRequestContext } from '@playwright/test';
import { appState, expect, isMobile, openSandbox, sendMessage, test, uniq } from './fixtures.ts';
import type { SessionInfo, StandingAgent, TranscriptEvent } from '../shared/types.ts';

/**
 * Two people, one portal (docs/identity.md): every message records who wrote it, and what it causes carries that
 * person as requestedBy: the orchestrator's chat, workers started by hand or through an /mcp key bound to a login,
 * standing runs. The seeded logins are tester (the owner) and teammate ("Team Mate", a member), e2e/server.ts.
 */

const MATE = { userId: 'teammate', displayName: 'Team Mate' };
const OWNER = { userId: 'tester', displayName: 'tester' };

/** An API client signed in as the teammate. */
async function asMate(): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: test.info().project.use.baseURL });
  // The server hashes at most two passwords at once; parallel workers retry as it asks.
  await expect(async () => {
    const r = await ctx.post('/api/login', { data: { username: 'teammate', password: 'e2e-teammate-456' } });
    expect(r.ok(), await r.text()).toBeTruthy();
  }).toPass({ intervals: [100, 200, 400, 800], timeout: 15_000 });
  return ctx;
}

async function transcript(request: APIRequestContext, id: string): Promise<TranscriptEvent[]> {
  const r = await request.get(`/api/sessions/${id}/events?limit=500`);
  expect(r.ok()).toBeTruthy();
  return r.json();
}

/** The teammate's /mcp key, which e2e/server.ts wrote beside this server's data folder. */
function mateKey() {
  const port = new URL(test.info().project.use.baseURL!).port;
  return fs.readFileSync(path.join(os.tmpdir(), `ffsb-e2e-${port}`, 'teammate-key.txt'), 'utf8').trim();
}

/** One MCP tools/call over the stateless /mcp endpoint, as a remote Claude Code would make it. */
async function mcpCall(request: APIRequestContext, name: string, args: Record<string, unknown>) {
  const r = await request.post('/mcp', {
    headers: { authorization: `Bearer ${mateKey()}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  const body = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: body.result.content.map((c) => c.text).join('\n'), isError: !!body.result.isError };
}

test('who am I: each login has its user id, display name and role', async ({ authed: page }) => {
  expect(await (await page.request.get('/api/me')).json()).toMatchObject({ userId: 'tester', role: 'owner' });
  const mate = await asMate();
  expect(await (await mate.get('/api/me')).json()).toMatchObject({ username: 'teammate', userId: 'teammate', displayName: 'Team Mate', role: 'member' });
  await mate.dispose();
});

test("the shared orchestrator chat records each message's author and shows it", async ({ authed: page }) => {
  const tag = uniq('shared');
  const mate = await asMate();
  const orch = (await appState(page.request)).orchestratorId;
  await sendMessage(mate, orch, `from the teammate ${tag}`);
  await sendMessage(page.request, orch, `from the owner ${tag}`);
  const events = await transcript(page.request, orch);
  const mine = (text: string) => events.find((e) => e.kind === 'user' && e.text === text);
  expect(mine(`from the teammate ${tag}`)).toMatchObject({ from: 'human', requestedBy: MATE });
  expect(mine(`from the owner ${tag}`)).toMatchObject({ from: 'human', requestedBy: OWNER });
  // The fake agent echoes the message without the "[from <name>]" line the model reads.
  await expect(page.locator('.orch .msg-assistant', { hasText: `Echo: from the teammate ${tag}` })).toBeVisible();
  await expect(page.locator('.orch .msg-user', { hasText: `from the teammate ${tag}` }).getByTestId('msg-author')).toHaveText('Team Mate');
  await expect(page.locator('.orch .msg-user', { hasText: `from the owner ${tag}` }).getByTestId('msg-author')).toHaveText('tester');
  await mate.dispose();
});

test('a worker the teammate starts is requested by them; the owner writing to it is named in its chat', async ({ authed: page }) => {
  const tag = uniq('mateworker');
  const mate = await asMate();
  const r = await mate.post('/api/sessions', { data: { sandboxId: 'alpha', prompt: `hello ${tag}`, title: `Mate ${tag}` } });
  expect(r.ok(), await r.text()).toBeTruthy();
  const s = (await r.json()) as SessionInfo;
  expect(s.requestedBy).toEqual(MATE);
  await sendMessage(page.request, s.id, `owner here ${tag}`);

  const panel = await openSandbox(page, 'alpha', s.id);
  // The card says whom it works for: the tab on desktop, the agent switcher on a phone.
  if (isMobile(page)) await expect(panel.getByRole('combobox', { name: 'Agent' }).locator(`option[value="${s.id}"]`)).toContainText('for Team Mate');
  else await expect(panel.getByRole('tab', { name: `Mate ${tag}` }).getByTestId('tab-requested-by')).toHaveText('Team Mate');
  // Its own person's messages carry no name; someone else's do.
  await expect(panel.locator('.msg-user', { hasText: `hello ${tag}` }).getByTestId('msg-author')).toHaveCount(0);
  await expect(panel.locator('.msg-user', { hasText: `owner here ${tag}` }).getByTestId('msg-author')).toHaveText('tester');
  // The details say it too.
  const events = await transcript(page.request, s.id);
  expect(events.filter((e) => e.kind === 'user').map((e) => e.kind === 'user' && e.requestedBy?.userId)).toEqual(['teammate', 'tester']);
  const info = (await appState(page.request)).sessions.find((x) => x.id === s.id)!;
  expect(info.requestedBy).toEqual(MATE);
  expect(info.lastRequestedBy).toEqual(OWNER);
  await mate.dispose();
});

test('an /mcp key bound to the teammate: the workers and messages its tools start are requested by them', async ({ authed: page }) => {
  const tag = uniq('mcp');
  const started = await mcpCall(page.request, 'start_agent', { sandbox: 'alpha', prompt: `via mcp ${tag}`, title: `MCP ${tag}` });
  expect(started.isError, started.text).toBe(false);
  expect(started.text).toMatch(/requested by Team Mate/);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = (await appState(page.request)).sessions.find((x) => x.id === id)!;
  expect(info.requestedBy).toEqual(MATE);

  const sent = await mcpCall(page.request, 'message_agent', { session_id: id, text: `follow-up ${tag}` });
  expect(sent.text).toBe('Sent, for Team Mate.');
  const events = await transcript(page.request, id);
  expect(events.find((e) => e.kind === 'user' && e.text === `follow-up ${tag}`)).toMatchObject({ requestedBy: MATE });
  // A key acts for its own person only.
  const other = await mcpCall(page.request, 'message_agent', { session_id: id, text: 'x', for_user: 'tester' });
  expect(other.isError).toBe(true);
  expect(other.text).toMatch(/acts for teammate/);
});

test('a standing run started by hand is requested by whoever pressed Run now', async ({ authed: page }) => {
  const name = uniq('Standing');
  const r = await page.request.post('/api/standing', { data: { name, charter: 'Say hello.', trigger: { kind: 'manual' } } });
  expect(r.ok(), await r.text()).toBeTruthy();
  const a = (await r.json()) as StandingAgent;
  const mate = await asMate();
  expect((await mate.post(`/api/standing/${a.id}/run`, { data: {} })).ok()).toBeTruthy();
  await expect
    .poll(async () => (await appState(page.request)).standingAgents.find((x) => x.id === a.id)?.runs.at(-1)?.requestedBy)
    .toEqual(MATE);
  await mate.dispose();
  await page.request.delete(`/api/standing/${a.id}`);
});
