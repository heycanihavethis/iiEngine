import { invoke, isTauri } from '@tauri-apps/api/core';
import { ApiError, apiRequest } from './api';
import { detectGame } from './launcher';

export type TrackerFlag = {
  schema_version: number;
  enabled: boolean;
};

export type LocalPresence = {
  schema_version: number;
  username: string;
  room_code: string;
  in_room: boolean;
  updated_at: string;
};

export type TrackedPlayer = {
  user_id: string;
  display_name: string;
  username: string;
  avatar: string | null;
  room_code: string;
  in_room: boolean;
  updated_at: string;
  online: boolean;
  seconds_ago: number;
  status: 'in_room' | 'online' | 'offline' | string;
};

async function gameOrDetect(gamePath?: string) {
  return gamePath || (await detectGame());
}

export async function getSelfTracker(gamePath?: string) {
  if (!isTauri()) return { schema_version: 1, enabled: false } satisfies TrackerFlag;
  const path = await gameOrDetect(gamePath);
  return invoke<TrackerFlag>('get_self_tracker', { gamePath: path });
}

export async function setSelfTracker(enabled: boolean, gamePath?: string) {
  if (!isTauri()) throw new Error('Self Tracker requires the Windows desktop app.');
  const path = await gameOrDetect(gamePath);
  return invoke<TrackerFlag>('set_self_tracker', { gamePath: path, enabled });
}

export async function readLocalPresence(gamePath?: string) {
  if (!isTauri()) return null;
  const path = await gameOrDetect(gamePath);
  return invoke<LocalPresence | null>('read_local_presence', { gamePath: path });
}

export async function upsertTrackerPresence(presence: {
  username: string;
  room_code: string;
  in_room: boolean;
  updated_at: string;
}) {
  const response = await apiRequest('/v1/tracker/presence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(presence),
  });
  return response.json() as Promise<TrackedPlayer>;
}

export async function clearTrackerPresence() {
  await apiRequest('/v1/tracker/presence', { method: 'DELETE' });
}

export async function listTrackedPlayers() {
  try {
    const response = await apiRequest('/v1/tracker/players');
    return response.json() as Promise<{
      players: TrackedPlayer[];
      stale_after_seconds: number;
      unavailable?: boolean;
    }>;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return {
        players: [] as TrackedPlayer[],
        stale_after_seconds: 12 * 60,
        unavailable: true,
      };
    }
    throw error;
  }
}

export type TrackerFeedItem = {
  id: string;
  author: string;
  avatar: string | null;
  text: string;
  embed_title: string;
  embed_description: string;
  username?: string;
  player_id?: string;
  room?: string;
  region?: string;
  cosmetic?: string;
  color?: string;
  platform?: string;
  track_kind?: 'rare' | 'player' | string;
  timestamp: string;
  url: string;
};

export type TrackerFeed = {
  schema_version: number;
  enabled?: boolean;
  live?: boolean;
  configured: boolean;
  unavailable: boolean;
  items: TrackerFeedItem[];
  reason: string | null;
  lookback_seconds?: number;
  retention_seconds?: number;
  lookback_choices_seconds?: number[];
  bot_issue?: boolean;
  admin_hint?: {
    kind?: string | null;
    discord_http_status?: number | null;
    channel_configured?: boolean;
  };
};

export type TrackerSession = {
  token: string;
  expires_at: string;
  ttl_seconds: number;
  day: string;
};

export async function issueTrackerSession() {
  const response = await apiRequest('/v1/tracker/session', { method: 'POST' });
  return response.json() as Promise<TrackerSession>;
}

export async function fetchTrackerFeed(sessionToken: string, lookbackSeconds?: number) {
  try {
    const query =
      typeof lookbackSeconds === 'number' && Number.isFinite(lookbackSeconds)
        ? `?lookback_seconds=${Math.max(60, Math.min(3 * 60 * 60, Math.floor(lookbackSeconds)))}`
        : '';
    const response = await apiRequest(`/v1/tracker/feed${query}`, {
      headers: { 'X-Tracker-Session': sessionToken },
    });
    return response.json() as Promise<TrackerFeed>;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return {
        schema_version: 1,
        enabled: false,
        live: false,
        configured: false,
        unavailable: true,
        items: [],
        reason: 'Tracker feed is updating on the server.',
      } satisfies TrackerFeed;
    }
    throw error;
  }
}
