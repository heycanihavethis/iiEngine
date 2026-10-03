import { apiRequest } from './api';

export type TrackerScoutSearch = {
  field: string;
  q: string;
  hits: number;
  day?: string | null;
  hour_utc?: number | null;
};

export type TrackerScoutPlayer = {
  key: string;
  username: string;
  playerId: string;
  room: string;
  region: string;
  color: string;
  platform: string;
  trackKind: string;
  lastSeen: string;
  sightings: number;
};

export type TrackerScoutResult = {
  answer: string;
  remaining: number | null;
  resetAt: string | null;
  mode: 'chat' | 'search' | string;
  searches: TrackerScoutSearch[];
  players: TrackerScoutPlayer[];
  hitCount: number | null;
  dailyLimit: number | null;
};

function mapPlayer(raw: Record<string, unknown>): TrackerScoutPlayer | null {
  const username = String(raw.username || '').trim();
  const playerId = String(raw.player_id || '')
    .trim()
    .toUpperCase();
  if (!username && !playerId) return null;
  return {
    key: String(raw.key || (playerId ? `ID:${playerId}` : `NICK:${username.toUpperCase()}`)),
    username: username || playerId.slice(0, 8) || 'Player',
    playerId,
    room: String(raw.room || '')
      .trim()
      .toUpperCase(),
    region: String(raw.region || '')
      .trim()
      .toUpperCase(),
    color: String(raw.color || '').trim(),
    platform: String(raw.platform || '').trim(),
    trackKind: String(raw.track_kind || 'player').trim(),
    lastSeen: String(raw.last_seen || '').trim(),
    sightings: typeof raw.sightings === 'number' ? raw.sightings : 1,
  };
}

export async function askTrackerScout(message: string): Promise<TrackerScoutResult> {
  const trimmed = message.trim().slice(0, 500);
  if (!trimmed) {
    throw new Error('Enter a question');
  }
  const response = await apiRequest('/v1/ai/tracker-scout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: trimmed, share_telemetry: false }),
  });
  const body = (await response.json()) as {
    answer?: string;
    remaining?: number;
    reset_at?: string;
    mode?: string;
    searches?: TrackerScoutSearch[];
    players?: Record<string, unknown>[];
    hit_count?: number;
    daily_limit?: number;
    detail?: string;
  };
  const players = Array.isArray(body.players)
    ? body.players
        .map((row) => mapPlayer(row || {}))
        .filter((row): row is TrackerScoutPlayer => !!row)
        .slice(0, 24)
    : [];
  let answer = sanitizeScoutAnswer(body.answer || '');
  if (!answer) {
    if (
      typeof body.detail === 'string' &&
      body.detail.trim() &&
      !/blank|empty/i.test(body.detail)
    ) {
      throw new Error(body.detail.trim());
    }
    answer = players.length
      ? `Found ${players.length} player${players.length === 1 ? '' : 's'} from recent sightings.`
      : 'I checked recent sightings but could not phrase a clean answer. Try a player name, room, or time window.';
  }
  return {
    answer,
    remaining: typeof body.remaining === 'number' ? body.remaining : null,
    resetAt: body.reset_at || null,
    mode: body.mode || 'chat',
    searches: Array.isArray(body.searches) ? body.searches : [],
    players,
    hitCount: typeof body.hit_count === 'number' ? body.hit_count : null,
    dailyLimit: typeof body.daily_limit === 'number' ? body.daily_limit : null,
  };
}

export function sanitizeScoutAnswer(raw: string): string {
  let text = (raw || '').trim();
  if (!text) return '';
  text = text.replace(/```(?:json)?\s*|```/gi, '').trim();
  if (/^\s*\{\s*"mode"\s*:/i.test(text)) {
    try {
      const parsed = JSON.parse(text) as { mode?: string; reply?: string };
      if (parsed && typeof parsed === 'object') {
        if (String(parsed.mode || '').toLowerCase() === 'chat') {
          const reply = String(parsed.reply || '').trim();
          return reply && !/^\s*\{\s*"mode"\s*:/i.test(reply) ? reply.slice(0, 4500) : '';
        }
        if (String(parsed.mode || '').toLowerCase() === 'search') {
          return '';
        }
      }
    } catch {
      return '';
    }
  }
  text = text.replace(/\{\s*"mode"\s*:\s*"(?:chat|search)"[\s\S]*?\}\s*/gi, (match) => {
    try {
      const parsed = JSON.parse(match) as { mode?: string; reply?: string };
      if (String(parsed.mode || '').toLowerCase() === 'chat') {
        return String(parsed.reply || '').trim() + ' ';
      }
    } catch {}
    return ' ';
  });
  text = text.replace(/\s{2,}/g, ' ').trim();
  if (!text || /^\s*\{\s*"mode"\s*:/i.test(text)) return '';
  return text.slice(0, 4500);
}

export function scoutColorCss(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^#[0-9A-Fa-f]{6}$/.test(value)) return value;
  const parts = value.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 3 && parts.every((part) => /^\d{1,3}$/.test(part))) {
    const [r, g, b] = parts.map((part) => Math.max(0, Math.min(255, Number(part))));
    return `rgb(${r}, ${g}, ${b})`;
  }
  return null;
}

export function formatScoutSeen(timestamp: string): string {
  const stamp = Date.parse(timestamp);
  if (!Number.isFinite(stamp)) return '';
  const delta = Math.max(0, Date.now() - stamp);
  if (delta < 60_000) return 'Just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(stamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
