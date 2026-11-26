import type { MachineSandbox } from './types.ts';

/**
 * Light agent folders (w5924) ride the daemon's sandbox list as `kind: "light"`: a plain folder for work that needs only an
 * agent slot (no game checkout, no Unity editor, no Library). Everything that counts, picks or manages game sandboxes
 * (max_sandboxes, FREE marking, a game placement, unity, switch_branch) goes through `gameSandboxes`; light folders count
 * against the machine's agent cap only.
 */
export const isLight = (sb: Pick<MachineSandbox, 'kind'> | undefined): boolean => sb?.kind === 'light';
export const gameSandboxes = <T extends Pick<MachineSandbox, 'kind'>>(list: readonly T[] | undefined): T[] => (list ?? []).filter((s) => !isLight(s));
export const lightFolders = <T extends Pick<MachineSandbox, 'kind'>>(list: readonly T[] | undefined): T[] => (list ?? []).filter((s) => isLight(s));
