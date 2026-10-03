import type { TrackerFeedItem } from './trackerApi';

const HISTORY_KEY = 'ii.tracker.sightingHistory.v1';
const WATCH_KEY = 'ii.tracker.watchlist.v1';
export const SIGHTING_KEEP_MS = 5 * 24 * 60 * 60 * 1000;
export const WATCH_ONLINE_MS = 12 * 60 * 1000;

export type WatchTarget = {
  playerId: string;
  nick: string;
  cosmetic?: string;
  room?: string;
  region?: string;
  addedAt: string;
};

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function readSightingHistory(): TrackerFeedItem[] {
  const rows = safeParse<TrackerFeedItem[]>(localStorage.getItem(HISTORY_KEY), []);
  if (!Array.isArray(rows)) return [];
  const cutoff = Date.now() - SIGHTING_KEEP_MS;
  return rows.filter((item) => {
    const stamp = Date.parse(item.timestamp || '');
    return Number.isFinite(stamp) && stamp >= cutoff;
  });
}

export function writeSightingHistory(items: TrackerFeedItem[]) {
  try {
    const cutoff = Date.now() - SIGHTING_KEEP_MS;
    const kept = items
      .filter((item) => {
        const stamp = Date.parse(item.timestamp || '');
        return Number.isFinite(stamp) && stamp >= cutoff;
      })
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, 2000);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(kept));
  } catch {}
}

export function mergeSightingHistory(live: TrackerFeedItem[]): TrackerFeedItem[] {
  const byId = new Map<string, TrackerFeedItem>();
  for (const item of readSightingHistory()) byId.set(item.id, item);
  for (const item of live) byId.set(item.id, item);
  const merged = [...byId.values()];
  writeSightingHistory(merged);
  return merged;
}

export function readWatchlist(): WatchTarget[] {
  const rows = safeParse<WatchTarget[]>(localStorage.getItem(WATCH_KEY), []);
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row && typeof row.playerId === 'string' && row.playerId.trim());
}

export function writeWatchlist(items: WatchTarget[]) {
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify(items.slice(0, 80)));
  } catch {}
}

export function addWatchTarget(target: Omit<WatchTarget, 'addedAt'>): WatchTarget[] {
  const playerId = target.playerId.trim().toUpperCase();
  if (!playerId) return readWatchlist();
  const next = readWatchlist().filter((row) => row.playerId.toUpperCase() !== playerId);
  next.unshift({
    playerId,
    nick: target.nick.trim() || playerId,
    cosmetic: (target.cosmetic || '').trim() || undefined,
    room: (target.room || '').trim().toUpperCase() || undefined,
    region: (target.region || '').trim().toUpperCase() || undefined,
    addedAt: new Date().toISOString(),
  });
  writeWatchlist(next);
  return next;
}

export function removeWatchTarget(playerId: string): WatchTarget[] {
  const key = playerId.trim().toUpperCase();
  const next = readWatchlist().filter((row) => row.playerId.toUpperCase() !== key);
  writeWatchlist(next);
  return next;
}

export function isWatched(playerId: string): boolean {
  const key = playerId.trim().toUpperCase();
  if (!key) return false;
  return readWatchlist().some((row) => row.playerId.toUpperCase() === key);
}

export function searchSightings(
  query: string,
  history: TrackerFeedItem[],
  now = Date.now(),
): TrackerFeedItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const cutoff = now - SIGHTING_KEEP_MS;
  const scored = history
    .filter((item) => {
      const stamp = Date.parse(item.timestamp || '');
      return Number.isFinite(stamp) && stamp >= cutoff;
    })
    .map((item) => {
      const nick = (item.username || item.author || '').toLowerCase();
      const id = (item.player_id || '').toLowerCase();
      const room = (item.room || '').toLowerCase();
      const hay = [nick, id, room, item.region, item.cosmetic, item.text]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      let score = 0;
      if (id === q || nick === q || room === q) score = 3;
      else if (id.includes(q) || nick.includes(q) || room.includes(q)) score = 2;
      else if (hay.includes(q)) score = 1;
      return { item, score, stamp: Date.parse(item.timestamp) };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.stamp - a.stamp);

  const best = new Map<string, TrackerFeedItem>();
  for (const row of scored) {
    const key = (row.item.player_id || row.item.username || row.item.author || row.item.id)
      .toString()
      .toUpperCase();
    if (!best.has(key)) best.set(key, row.item);
  }
  return [...best.values()].slice(0, 40);
}
