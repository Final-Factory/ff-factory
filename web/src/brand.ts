// The product's name on this install (w15, docs/project.md): "FF Factory" on Final Factory's own install, "Ryding Factory"
// on every other, whose page reads "Ryding Factory for <project>". The server says which (AppState.config.project.product).
import type { ProjectView } from '../../shared/types';
import { getState, useStore } from './store';

export const FINAL_FACTORY_PRODUCT = 'FF Factory';

/** The name the server gave the page before any script ran (server/webStatic.ts withBrand), for the login page. */
const served = typeof document !== 'undefined' && document.title ? document.title : FINAL_FACTORY_PRODUCT;

export const productOf = (p: ProjectView | undefined): string => p?.product ?? FINAL_FACTORY_PRODUCT;

/** The install's title: "FF Factory", or "Ryding Factory for Lens Scout" (the project's name alone from an older server). */
export const brandOf = (p: ProjectView | undefined): string => (p?.custom ? (p.product ? `${p.product} for ${p.name}` : p.name) : productOf(p));

export function useProduct(): string {
  return useStore((s) => productOf(s.app?.config?.project));
}

/** Outside React (a notification's title). */
export const currentProduct = (): string => productOf(getState().app?.config?.project);

/** Before login, when the app state is not there yet. */
export const servedBrand = (): string => served;
