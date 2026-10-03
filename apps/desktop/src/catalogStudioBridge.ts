export type CatalogSourceIntent = {
  modName: string;
  category: string;
  createdAt: number;
};

const KEY = 'ii-catalog-studio-source';

export function queueCatalogSourceIntent(modName: string, category: string) {
  const intent: CatalogSourceIntent = {
    modName: modName.trim(),
    category: category.trim(),
    createdAt: Date.now(),
  };
  if (!intent.modName) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(intent));
  } catch {}
}

export function takeCatalogSourceIntent(): CatalogSourceIntent | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as CatalogSourceIntent;
    if (!parsed?.modName || Date.now() - Number(parsed.createdAt || 0) > 5 * 60_000) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function catalogProjectName(modName: string) {
  const slug = modName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 28);
  const stamp = Date.now().toString(36).slice(-4);
  return `catalog-${slug || 'mod'}-${stamp}`;
}
