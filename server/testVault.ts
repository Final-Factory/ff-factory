// For tests only (w1078): every Claude process runs on a vault token and nothing falls back, so a test that starts
// orchestrators, workers or standing agents sets a vault context first. This fake gives every person one token of their
// own; its values are obvious fakes, built here so no scanner mistakes them for a real token.
import { createHash } from 'node:crypto';
import { setVaultContext, type Vault, type VaultContext } from './vault.ts';
import type { VaultEntryMeta } from '../shared/types.ts';

/** The fake token a person's runs get: never a real one. */
export const fakeToken = (person = 'nobody') => `sk-ant-oat01-${`fake-test-token-${person}-`.padEnd(48, 'x')}`;

/** A fake Claude entry for `person`, its fingerprint the token's as the usage meters key it. */
export function fakeEntry(person = 'nobody'): VaultEntryMeta {
  const t = fakeToken(person);
  return {
    id: `fake-${person}`,
    name: `vault-${person}-1`,
    kind: 'claude',
    owner: person,
    share: 'owner',
    roles: ['workers', 'standing'],
    machines: ['*'],
    fingerprint: createHash('sha256').update(t).digest('hex').slice(0, 12),
    last4: t.slice(-4),
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
  } as VaultEntryMeta;
}

/**
 * Sets a vault context where every person has one token (their own fake) and every pinned name opens; `over` replaces any
 * part (a test's own forRun, payer or onProblem). Returns the context, so a test can read what it was asked.
 */
export function useFakeVault(over: Partial<VaultContext> & { vault?: Partial<Vault> } = {}): VaultContext {
  const vault = {
    forRun: (run: { userId?: string }, o: { claude: boolean }) => ({
      env: {},
      problems: [],
      ...(o.claude ? { poolSize: 1, claude: { entry: fakeEntry(run.userId), token: fakeToken(run.userId), how: 'normal' as const } } : {}),
    }),
    claudeByName: (name: string) => ({ entry: { ...fakeEntry(name), name }, token: fakeToken(name) }),
    claudeTokens: () => [],
    lastPickOf: () => undefined,
    ...over.vault,
  } as unknown as Vault;
  const ctx: VaultContext = { payer: () => 'ben', ...over, vault };
  setVaultContext(ctx);
  return ctx;
}
