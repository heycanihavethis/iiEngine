export type LoadoutModRef = {
  source: 'trusted' | 'community';
  id: string;
  name: string;
  filename: string;
};

export type ModLoadout = {
  id: string;
  name: string;
  mods: LoadoutModRef[];
  updatedAt: number;
};

const KEY = 'ii-engine-mod-loadouts-v1';

function uid() {
  return `lo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function readLoadouts(): ModLoadout[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ModLoadout[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string')
      .map((item) => ({
        id: item.id,
        name: String(item.name).slice(0, 48) || 'Loadout',
        mods: Array.isArray(item.mods) ? item.mods.slice(0, 80) : [],
        updatedAt: Number(item.updatedAt) || Date.now(),
      }));
  } catch {
    return [];
  }
}

export function writeLoadouts(loadouts: ModLoadout[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadouts.slice(0, 24)));
  } catch {}
}

export function createLoadout(name = 'New loadout'): ModLoadout {
  const loadouts = readLoadouts();
  const next: ModLoadout = {
    id: uid(),
    name: name.trim().slice(0, 48) || 'New loadout',
    mods: [],
    updatedAt: Date.now(),
  };
  writeLoadouts([next, ...loadouts]);
  return next;
}

export function renameLoadout(id: string, name: string) {
  const loadouts = readLoadouts().map((item) =>
    item.id === id
      ? { ...item, name: name.trim().slice(0, 48) || item.name, updatedAt: Date.now() }
      : item,
  );
  writeLoadouts(loadouts);
  return loadouts.find((item) => item.id === id) ?? null;
}

export function deleteLoadout(id: string) {
  writeLoadouts(readLoadouts().filter((item) => item.id !== id));
}

export function setLoadoutMods(id: string, mods: LoadoutModRef[]) {
  const loadouts = readLoadouts().map((item) =>
    item.id === id ? { ...item, mods: mods.slice(0, 80), updatedAt: Date.now() } : item,
  );
  writeLoadouts(loadouts);
  return loadouts.find((item) => item.id === id) ?? null;
}

export function toggleLoadoutMod(id: string, mod: LoadoutModRef) {
  const current = readLoadouts().find((item) => item.id === id);
  if (!current) return null;
  const exists = current.mods.some((item) => item.source === mod.source && item.id === mod.id);
  const mods = exists
    ? current.mods.filter((item) => !(item.source === mod.source && item.id === mod.id))
    : [...current.mods, mod];
  return setLoadoutMods(id, mods);
}
