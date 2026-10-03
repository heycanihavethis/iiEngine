import type { ReleaseCatalog } from './launcher';

const STORAGE_KEY = 'ii-engine-menu-catalog-v1';
const MAX_AGE_MS = 30 * 60 * 1000;

export function rememberMenuCatalog(catalog: ReleaseCatalog | null | undefined) {
  if (typeof localStorage === 'undefined' || !catalog?.items?.length) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), catalog }));
  } catch {}
}

export function readMenuCatalogCache(): ReleaseCatalog | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: number; catalog?: ReleaseCatalog };
    if (
      !parsed?.savedAt ||
      Date.now() - parsed.savedAt > MAX_AGE_MS ||
      !parsed.catalog?.items?.some((item) => item.sha256?.length === 64)
    ) {
      return null;
    }
    return parsed.catalog;
  } catch {
    return null;
  }
}

export function clearMenuCatalogCache() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}
