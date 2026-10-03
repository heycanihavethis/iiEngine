import { apiRequest } from './api';
import type { TrackerFeedItem } from './trackerApi';
import { parseRgbTuple } from './trackerBoard';
import { parseAssistActions, type TrackerAssistAction } from './trackerNav';
import { readWatchlist, type WatchTarget } from './trackerWatch';

const MAX_DIGEST_CHARS = 8000;
const MAX_PLAYERS = 120;
const MAX_QUESTION = 500;

export type TrackerAssistResult = {
  answer: string;
  actions: TrackerAssistAction[];
  remaining: number | null;
  resetAt: string | null;
  source: 'local' | 'ai';
};

type PlayerRollup = {
  nick: string;
  playerId: string;
  color: string;
  platform: string;
  cosmetics: string[];
  rooms: string[];
  regions: string[];
  firstMs: number;
  lastMs: number;
  count: number;
  hours: Set<number>;
  days: Map<string, number[]>;
  rareCount: number;
};

function nickOf(item: TrackerFeedItem) {
  return (item.username || item.author || 'Player').trim() || 'Player';
}

function keyOf(item: TrackerFeedItem) {
  const id = (item.player_id || '').trim().toUpperCase();
  if (id) return `ID:${id}`;
  return `NICK:${nickOf(item).toUpperCase()}`;
}

function hourUtc(ms: number) {
  return new Date(ms).getUTCHours();
}

function dayKey(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

function formatHour(h: number) {
  return `${String(h).padStart(2, '0')}:00Z`;
}

function questionTokens(question: string): string[] {
  const tokens = new Set<string>();
  for (const match of question.matchAll(/\b([A-F0-9]{8,32})\b/gi)) {
    tokens.add(match[1].toUpperCase());
  }
  for (const match of question.matchAll(/\b([A-Z0-9]{2,8})\b/g)) {
    tokens.add(match[1].toUpperCase());
  }
  for (const word of question.split(/[^A-Za-z0-9_]+/)) {
    if (word.length >= 3) tokens.add(word.toUpperCase());
  }
  return [...tokens];
}

function rowMatchesQuestion(row: PlayerRollup, tokens: string[]) {
  if (!tokens.length) return false;
  const hay = [row.nick, row.playerId, ...row.rooms, ...row.regions, ...row.cosmetics, row.platform]
    .join(' ')
    .toUpperCase();
  return tokens.some((token) => token.length >= 2 && hay.includes(token));
}

export function buildTrackerDigest(
  history: TrackerFeedItem[],
  options: {
    now?: number;
    maxChars?: number;
    question?: string;
    watchlist?: WatchTarget[];
  } = {},
): string {
  const now = options.now ?? Date.now();
  const maxChars = options.maxChars ?? MAX_DIGEST_CHARS;
  const cutoff = now - 3 * 24 * 60 * 60 * 1000;
  const tokens = questionTokens(options.question || '');
  const rollups = new Map<string, PlayerRollup>();

  for (const item of history) {
    const stamp = Date.parse(item.timestamp || '');
    if (!Number.isFinite(stamp) || stamp < cutoff) continue;
    const key = keyOf(item);
    const nick = nickOf(item);
    const playerId = (item.player_id || '').trim().toUpperCase();
    let row = rollups.get(key);
    if (!row) {
      row = {
        nick,
        playerId,
        color: (item.color || '').trim(),
        platform: (item.platform || '').trim(),
        cosmetics: [],
        rooms: [],
        regions: [],
        firstMs: stamp,
        lastMs: stamp,
        count: 0,
        hours: new Set(),
        days: new Map(),
        rareCount: 0,
      };
      rollups.set(key, row);
    }
    row.count += 1;
    row.firstMs = Math.min(row.firstMs, stamp);
    row.lastMs = Math.max(row.lastMs, stamp);
    if (nick && nick !== 'Player') row.nick = nick;
    if (playerId) row.playerId = playerId;
    if (!row.color && item.color) row.color = item.color.trim();
    if (!row.platform && item.platform) row.platform = item.platform.trim();
    if (item.track_kind === 'rare') row.rareCount += 1;
    const cosmetic = (item.cosmetic || '').trim();
    if (cosmetic && !row.cosmetics.includes(cosmetic) && row.cosmetics.length < 6) {
      row.cosmetics.push(cosmetic.slice(0, 40));
    }
    const room = (item.room || '').trim().toUpperCase();
    const region = (item.region || '').trim().toUpperCase();
    if (room && !row.rooms.includes(room)) row.rooms.push(room);
    if (region && !row.regions.includes(region)) row.regions.push(region);
    const hour = hourUtc(stamp);
    row.hours.add(hour);
    const day = dayKey(stamp);
    const dayHours = row.days.get(day) || [];
    if (!dayHours.includes(hour)) dayHours.push(hour);
    row.days.set(day, dayHours);
  }

  const all = [...rollups.values()];
  const pinned = all.filter((row) => rowMatchesQuestion(row, tokens));
  const rest = all
    .filter((row) => !pinned.includes(row))
    .sort((a, b) => b.lastMs - a.lastMs || b.count - a.count);
  const ranked = [...pinned.sort((a, b) => b.lastMs - a.lastMs), ...rest].slice(0, MAX_PLAYERS);

  const watch = (options.watchlist || readWatchlist()).slice(0, 40);
  const lines = [
    'TRACKER_DIGEST v2 window=3d players=' +
      ranked.length +
      ' pinned=' +
      pinned.length +
      ' generated=' +
      new Date(now).toISOString(),
    'Fields: nick|id|color|platform|rooms|regions|cosmetics|first|last|sightings|rares|utc_hours_by_day',
  ];
  if (watch.length) {
    const watchBits = watch.map((row) => {
      const nick = (row.nick || 'Player').replace(/[|,]/g, ' ');
      return nick + ':' + row.playerId.toUpperCase();
    });
    lines.push('WATCHLIST: ' + watchBits.join(', '));
  }

  for (const row of ranked) {
    const dayBits = [...row.days.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map((entry) => {
        const day = entry[0];
        const hours = entry[1]
          .slice()
          .sort((a, b) => a - b)
          .map(formatHour)
          .join(',');
        return day + '@' + hours;
      })
      .join(';');
    const line = [
      row.nick.replace(/[|\n]/g, ' ').slice(0, 28),
      row.playerId || '-',
      row.color || '-',
      (row.platform || '-').replace(/[|\n]/g, ' ').slice(0, 16),
      row.rooms.slice(0, 10).join(',') || '-',
      row.regions.slice(0, 6).join(',') || '-',
      row.cosmetics.join(',') || '-',
      new Date(row.firstMs).toISOString(),
      new Date(row.lastMs).toISOString(),
      String(row.count),
      String(row.rareCount),
      dayBits || '-',
    ].join('|');
    if (lines.join('\n').length + line.length + 1 > maxChars) break;
    lines.push(line);
  }
  return lines.join('\n').slice(0, maxChars);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
}

type DigestRow = {
  nick: string;
  id: string;
  color: string;
  platform: string;
  rooms: string;
  regions: string;
  cosmetics: string;
  first: string;
  last: string;
  count: string;
  rares: string;
  hours: string;
};

function parseDigestRows(digest: string): DigestRow[] {
  return digest
    .split('\n')
    .filter(
      (line) =>
        line.includes('|') &&
        !line.startsWith('TRACKER_DIGEST') &&
        !line.startsWith('Fields:') &&
        !line.startsWith('WATCHLIST:'),
    )
    .map((line) => {
      const parts = line.split('|');
      if (parts.length <= 9) {
        const [nick, id, color, rooms, regions, first, last, count, hours] = parts;
        return {
          nick,
          id,
          color,
          platform: '-',
          rooms,
          regions,
          cosmetics: '-',
          first,
          last,
          count,
          rares: '0',
          hours,
        };
      }
      const [
        nick,
        id,
        color,
        platform,
        rooms,
        regions,
        cosmetics,
        first,
        last,
        count,
        rares,
        hours,
      ] = parts;
      return {
        nick,
        id,
        color,
        platform,
        rooms,
        regions,
        cosmetics,
        first,
        last,
        count,
        rares,
        hours,
      };
    })
    .filter((row) => row.nick);
}

function withTargetActions(body: string, target?: DigestRow | null, room?: string) {
  const chips: string[] = [];
  if (target?.id && target.id !== '-') {
    chips.push(`[[target:${target.id}]]`, `[[player:${target.id}]]`);
  }
  if (room) chips.push(`[[room:${room}]]`);
  chips.push('[[section:assist]]');
  return parseAssistActions([body, ...chips].join('\n'));
}

export function tryLocalTrackerAnswer(
  question: string,
  history: TrackerFeedItem[],
  options: { now?: number } = {},
): TrackerAssistResult | null {
  const now = options.now ?? Date.now();
  const q = question.trim();
  if (!q) return null;
  const lower = q.toLowerCase();
  const digest = buildTrackerDigest(history, { now, question: q });
  const rows = parseDigestRows(digest);

  const idMatch = q.match(/\b([A-F0-9]{8,32})\b/i);
  let target = idMatch
    ? rows.find((row) => row.id.toUpperCase() === idMatch[1].toUpperCase())
    : undefined;

  if (!target) {
    const nickCandidates = rows
      .map((row) => row.nick)
      .filter((nick) => nick && nick !== '-')
      .sort((a, b) => b.length - a.length);
    for (const nick of nickCandidates) {
      if (new RegExp(`\\b${escapeRegExp(nick)}\\b`, 'i').test(q)) {
        target = rows.find((row) => row.nick === nick);
        break;
      }
    }
  }

  const asksWhen =
    /\b(when|what times?|online|seen|active|last seen|schedule)\b/i.test(lower) ||
    /\bwas\b.+\bonline\b/i.test(lower);
  const asksRoom = /\b(room|lobby|directory|code)\b/i.test(lower);
  const asksWhoInRoom = /\b(who|anyone|players?).+\b(in|at)\b/i.test(lower) || asksRoom;

  if (target && asksWhen) {
    const hours = (target.hours || '-')
      .split(';')
      .filter(Boolean)
      .map((chunk) => `• ${chunk.replace('@', ' → ')}`)
      .join('\n');
    const body = [
      `${target.nick}${target.id !== '-' ? ` (${target.id})` : ''} was seen in the last 3 days.`,
      `First: ${target.first}`,
      `Last: ${target.last}`,
      `Sightings: ${target.count}`,
      target.rooms !== '-' ? `Rooms: ${target.rooms}` : null,
      target.regions !== '-' ? `Regions: ${target.regions}` : null,
      target.platform && target.platform !== '-' ? `Platform: ${target.platform}` : null,
      target.cosmetics && target.cosmetics !== '-' ? `Cosmetics: ${target.cosmetics}` : null,
      hours ? `UTC hours by day:\n${hours}` : null,
      'Jump below to watch them on Target Tracker or find them on the board.',
    ]
      .filter(Boolean)
      .join('\n');
    const parsed = withTargetActions(body, target);
    return { ...parsed, answer: parsed.text, remaining: null, resetAt: null, source: 'local' };
  }

  if (asksWhoInRoom) {
    const roomMatch =
      q.match(/\b(?:room|lobby|code|directory)\s*[:#]?\s*([A-Z0-9]{2,8})\b/i) ||
      q.match(/\b([A-Z0-9]{3,6})\b/);
    const room = (roomMatch?.[1] || '').toUpperCase();
    if (room && room.length >= 2) {
      const inRoom = rows.filter((row) =>
        (row.rooms || '')
          .split(',')
          .map((part) => part.trim().toUpperCase())
          .includes(room),
      );
      if (!inRoom.length) {
        return {
          answer: `No cached sightings in room ${room} over the last 3 days.`,
          actions: [{ kind: 'section', section: 'assist', label: 'Ask again' }],
          remaining: null,
          resetAt: null,
          source: 'local',
        };
      }
      const body = [
        `Players seen in room ${room} (last 3 days):`,
        ...inRoom
          .slice(0, 20)
          .map(
            (row) =>
              `• ${row.nick}${row.id !== '-' ? ` · ${row.id}` : ''} · last ${row.last} · n=${row.count}`,
          ),
        inRoom.length > 20 ? `…and ${inRoom.length - 20} more` : null,
      ]
        .filter(Boolean)
        .join('\n');
      const chips = [
        `[[room:${room}]]`,
        ...inRoom
          .filter((row) => row.id && row.id !== '-')
          .slice(0, 3)
          .flatMap((row) => [`[[target:${row.id}]]`, `[[player:${row.id}]]`]),
        '[[section:players]]',
      ];
      const parsed = parseAssistActions([body, ...chips].join('\n'));
      return { ...parsed, answer: parsed.text, remaining: null, resetAt: null, source: 'local' };
    }
  }

  if (target && asksRoom) {
    const body = [
      `${target.nick}${target.id !== '-' ? ` (${target.id})` : ''}`,
      `Rooms: ${target.rooms}`,
      `Regions: ${target.regions}`,
      `Last seen: ${target.last}`,
    ].join('\n');
    const parsed = withTargetActions(body, target);
    return { ...parsed, answer: parsed.text, remaining: null, resetAt: null, source: 'local' };
  }

  if (/\b(color|colour|similar|same fur)\b/i.test(lower) && target?.color && target.color !== '-') {
    const seed = parseRgbTuple(target.color);
    if (seed) {
      const similar = rows.filter((row) => {
        if (row === target || !row.color || row.color === '-') return false;
        const rgb = parseRgbTuple(row.color);
        if (!rgb) return false;
        return (
          Math.abs(rgb[0] - seed[0]) <= 20 &&
          Math.abs(rgb[1] - seed[1]) <= 20 &&
          Math.abs(rgb[2] - seed[2]) <= 20
        );
      });
      const body = [
        `Players with colors near ${target.color} (±20):`,
        ...similar.slice(0, 15).map((row) => `• ${row.nick} · ${row.color} · last ${row.last}`),
        similar.length ? null : 'Nobody else in the cached digest is that close.',
      ]
        .filter(Boolean)
        .join('\n');
      const parsed = withTargetActions(body, target);
      return { ...parsed, answer: parsed.text, remaining: null, resetAt: null, source: 'local' };
    }
  }

  return null;
}

export async function askTrackerAssist(
  question: string,
  history: TrackerFeedItem[],
): Promise<TrackerAssistResult> {
  const trimmed = question.trim().slice(0, MAX_QUESTION);
  if (!trimmed) {
    return {
      answer: 'Ask about a player ID, nick, room, color, cosmetics, or when someone was online.',
      actions: [{ kind: 'section', section: 'assist', label: 'Ask Assist' }],
      remaining: null,
      resetAt: null,
      source: 'local',
    };
  }

  const local = tryLocalTrackerAnswer(trimmed, history);
  if (local) return local;

  const digest = buildTrackerDigest(history, {
    question: trimmed,
    watchlist: readWatchlist(),
  });
  const response = await apiRequest('/v1/ai/tracker-assist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: trimmed,
      digest,
      share_telemetry: false,
    }),
    timeoutMs: 50_000,
  });
  const payload = (await response.json()) as {
    answer?: string;
    remaining?: number;
    reset_at?: string;
  };

  const parsed = parseAssistActions((payload.answer || '').trim() || 'No answer returned.');
  return {
    answer: parsed.text,
    actions: parsed.actions,
    remaining: typeof payload.remaining === 'number' ? payload.remaining : null,
    resetAt: payload.reset_at || null,
    source: 'ai',
  };
}
