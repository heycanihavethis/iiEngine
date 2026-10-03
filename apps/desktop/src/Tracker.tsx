import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Clock, RefreshCw, Search, UserMinus, UserPlus, X } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { adminErrorDetail, errorMessage } from './api';
import { EngineIcon } from './EngineIcon';
import { trackFeature } from './telemetry';
import TrackerNodeBackdrop from './TrackerNodeBackdrop';
import { TrackerPaywall } from './TrackerPaywall';
import { fetchTrackerFeed, issueTrackerSession, type TrackerFeedItem } from './trackerApi';
import {
  addWatchTarget,
  isWatched,
  mergeSightingHistory,
  readSightingHistory,
  readWatchlist,
  removeWatchTarget,
  searchSightings,
  WATCH_ONLINE_MS,
  type WatchTarget,
} from './trackerWatch';
import { groupPlayerHits, PLAYER_VIEW_MODES, type PlayerViewMode } from './trackerBoard';
import { consumeTrackerNavIntent } from './trackerNav';
import type { Page } from './store';

type PlayerBoardFilter =
  | { kind: 'all' }
  | { kind: 'cosmetics' }
  | { kind: 'region'; value: string }
  | { kind: 'room'; value: string };

const FEED_POLL_MS = 25_000;
const RATE_LIMIT_POLL_MS = 3_000;
const RARE_FEATURED_MS = 10 * 60 * 1000;
const RARE_KEEP_MS = 2 * 24 * 60 * 60 * 1000;
const RARE_STORE_KEY = 'ii.tracker.rareArchive.v1';
const LOOKBACK_STORE_KEY = 'ii.tracker.playerLookbackSeconds.v1';
const VIEW_MODE_STORE_KEY = 'ii.tracker.playerViewMode.v1';
const LOOKBACK_OPTIONS: { seconds: number; label: string; short: string }[] = [
  { seconds: 3 * 60, label: 'Last 3 minutes', short: '3m' },
  { seconds: 15 * 60, label: 'Last 15 minutes', short: '15m' },
  { seconds: 60 * 60, label: 'Last 1 hour', short: '1h' },
  { seconds: 3 * 60 * 60, label: 'Last 3 hours', short: '3h' },
];

export function boardCapForLookback(seconds: number) {
  if (seconds <= 3 * 60) return 40;
  if (seconds <= 15 * 60) return 80;
  if (seconds <= 60 * 60) return 120;
  return 180;
}

export function isDiscordRateLimitedMessage(message: string, adminDetail: string | null = null) {
  if (/rate[- ]?limit/i.test(message)) return true;
  if (adminDetail && /rate_limited/i.test(adminDetail)) return true;
  return false;
}

function readStoredLookbackSeconds() {
  try {
    const raw = Number(localStorage.getItem(LOOKBACK_STORE_KEY) || '');
    if (LOOKBACK_OPTIONS.some((option) => option.seconds === raw)) return raw;
    if (Number.isFinite(raw) && raw > 0) {
      return LOOKBACK_OPTIONS[LOOKBACK_OPTIONS.length - 1].seconds;
    }
  } catch {}
  return LOOKBACK_OPTIONS[0].seconds;
}

function readStoredViewMode(): PlayerViewMode {
  try {
    const raw = localStorage.getItem(VIEW_MODE_STORE_KEY) || '';
    if (PLAYER_VIEW_MODES.some((mode) => mode.id === raw)) return raw as PlayerViewMode;
  } catch {}
  return 'list';
}

export type TrackerMode = 'player' | 'self' | 'target';

function stripMd(value: string) {
  return value
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/^[*_]+|[*_]+$/g, '')
    .trim();
}

type ParsedHit = {
  id: string;
  nick: string;
  playerId: string;
  room: string;
  region: string;
  cosmetic: string;
  color: string;
  platform: string;
  trackKind: 'rare' | 'player';
  avatar: string | null;
  timestamp: string;
  haystack: string;
  ageMs: number;
};

function watchKeyForHit(hit: Pick<ParsedHit, 'playerId' | 'nick'>) {
  if (hit.playerId) return hit.playerId;
  const nick = hit.nick.trim().toUpperCase();
  return nick ? `NICK:${nick}` : '';
}

function normalizeManualPlayerId(raw: string) {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-F0-9]/gi, '');
}

function isPlausiblePlayerId(id: string) {
  return /^[A-F0-9]{8,32}$/.test(id);
}

const DEMO_POOL: Array<Omit<TrackerFeedItem, 'id' | 'timestamp'>> = [
  {
    author: 'GhostFox',
    avatar: null,
    text: 'GhostFox · Neon Crown · Room XK7M · Region USW · ID A1B2C3D4E5F60718',
    embed_title: 'Neon Crown',
    embed_description: '',
    username: 'GhostFox',
    player_id: 'A1B2C3D4E5F60718',
    room: 'XK7M',
    region: 'USW',
    cosmetic: 'Neon Crown',
    color: '255 120 40',
    track_kind: 'rare',
    url: '',
  },
  {
    author: 'Mira',
    avatar: null,
    text: 'Mira · Obsidian Wings · Room Q9PL · Region USE · ID BEEFCAFE01234567',
    embed_title: 'Obsidian Wings',
    embed_description: '',
    username: 'Mira',
    player_id: 'BEEFCAFE01234567',
    room: 'Q9PL',
    region: 'USE',
    cosmetic: 'Obsidian Wings',
    color: '40 60 180',
    track_kind: 'rare',
    url: '',
  },
  {
    author: 'Volt',
    avatar: null,
    text: 'Volt · Room ZZ2A · Region EU · ID 8899AABBCCDDEEFF · PC',
    embed_title: 'Volt',
    embed_description: '',
    username: 'Volt',
    player_id: '8899AABBCCDDEEFF',
    room: 'ZZ2A',
    region: 'EU',
    cosmetic: 'LHAAS., LBAGO., LBASX.',
    platform: 'PC',
    color: '255 0 0',
    track_kind: 'player',
    url: '',
  },
  {
    author: 'Rune',
    avatar: null,
    text: 'Rune · Frost Halo · Room B4KE · Region USW · ID 1122334455667788',
    embed_title: 'Frost Halo',
    embed_description: '',
    username: 'Rune',
    player_id: '1122334455667788',
    room: 'B4KE',
    region: 'USW',
    cosmetic: 'Frost Halo',
    color: '170 227 255',
    track_kind: 'rare',
    url: '',
  },
  {
    author: 'Ash',
    avatar: null,
    text: 'Ash · Room H8RN · Region USW · ID DEADBEEF00C0FFEE · PC',
    embed_title: 'Ash',
    embed_description: '',
    username: 'Ash',
    player_id: 'DEADBEEF00C0FFEE',
    room: 'H8RN',
    region: 'USW',
    cosmetic: 'Slingshot, BUILD01',
    platform: 'PC',
    color: '0 180 255',
    track_kind: 'player',
    url: '',
  },
  {
    author: 'Nyx',
    avatar: null,
    text: 'Nyx · Room M1TO · Region USE · ID EDA1204079BEAB51 · PC',
    embed_title: 'Nyx',
    embed_description: '',
    username: 'Nyx',
    player_id: 'EDA1204079BEAB51',
    room: 'M1TO',
    region: 'USE',
    cosmetic: 'LBAVR., LBAVN.',
    platform: 'PC',
    track_kind: 'player',
    url: '',
  },
  {
    author: 'APEXPLAYS',
    avatar: null,
    text: 'APEXPLAYS · Room RUN · Region USW · ID AABBCCDDEEFF0011 · PC',
    embed_title: 'APEXPLAYS',
    embed_description: '',
    username: 'APEXPLAYS',
    player_id: 'AABBCCDDEEFF0011',
    room: 'RUN',
    region: 'USW',
    platform: 'PC',
    track_kind: 'player',
    url: '',
  },
  {
    author: 'FISH',
    avatar: null,
    text: 'FISH · Room 6W3S · Region EU · ID 0011223344556677 · PC',
    embed_title: 'FISH',
    embed_description: '',
    username: 'FISH',
    player_id: '0011223344556677',
    room: '6W3S',
    region: 'EU',
    platform: 'PC',
    track_kind: 'player',
    url: '',
  },
];

function formatSeen(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'Unknown';
  const delta = Math.max(0, Date.now() - parsed);
  if (delta < 45_000) return 'Just now';
  if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.max(1, Math.floor(delta / 86_400_000))}d ago`;
}

export function playerColorCss(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const hex = value.match(/^#?([0-9a-f]{6})$/i);
  if (hex) return `#${hex[1].toUpperCase()}`;
  const parts = value.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 3 && parts.every((part) => /^\d{1,3}$/.test(part))) {
    const [r, g, b] = parts.map(Number);
    if ([r, g, b].every((n) => n >= 0 && n <= 255)) return `rgb(${r}, ${g}, ${b})`;
  }
  return null;
}

export function formatPlayerColorLabel(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  const css = playerColorCss(value);
  if (!css) return value;
  if (css.startsWith('#')) return css;
  const match = css.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (match) return `${match[1]} ${match[2]} ${match[3]}`;
  return value;
}

async function copyText(value: string): Promise<boolean> {
  const text = value.trim();
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function readRareStore(): TrackerFeedItem[] {
  try {
    const raw = localStorage.getItem(RARE_STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TrackerFeedItem[];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - RARE_KEEP_MS;
    return parsed.filter((item) => {
      const stamp = Date.parse(item.timestamp || '');
      return Number.isFinite(stamp) && stamp >= cutoff && item.track_kind === 'rare';
    });
  } catch {
    return [];
  }
}

function writeRareStore(items: TrackerFeedItem[]) {
  try {
    const cutoff = Date.now() - RARE_KEEP_MS;
    const kept = items.filter((item) => {
      const stamp = Date.parse(item.timestamp || '');
      return Number.isFinite(stamp) && stamp >= cutoff && item.track_kind === 'rare';
    });
    localStorage.setItem(RARE_STORE_KEY, JSON.stringify(kept.slice(0, 120)));
  } catch {}
}

function mergeLiveWithRareStore(live: TrackerFeedItem[]): TrackerFeedItem[] {
  const stored = readRareStore();
  const byId = new Map<string, TrackerFeedItem>();
  for (const item of stored) byId.set(item.id, item);
  for (const item of live) {
    if (item.track_kind === 'rare') byId.set(item.id, { ...item, track_kind: 'rare' });
  }
  const rares = [...byId.values()];
  writeRareStore(rares);
  const players = live.filter((item) => item.track_kind === 'player');
  return [...rares, ...players];
}

function parseHit(item: TrackerFeedItem, now = Date.now()): ParsedHit {
  const blob = [
    item.username,
    item.player_id,
    item.room,
    item.region,
    item.cosmetic,
    item.color,
    item.platform,
    item.embed_title,
    item.embed_description,
    item.text,
    item.author,
  ]
    .filter(Boolean)
    .join(' · ');
  const parts = blob
    .split(/[·|•\-–—,/]+/)
    .map((part) => stripMd(part.trim()))
    .filter(Boolean);

  const idMatch =
    blob.match(/\b(?:id|player(?:\s*id)?)\s*[:#]?\s*([A-F0-9]{8,32})\b/i) ||
    blob.match(/\b([A-F0-9]{12,32})\b/i) ||
    blob.match(/\b(\d{6,})\b/);
  const roomMatch =
    blob.match(/\b(?:room|code|directory)\s*[:#]?\s*([A-Z0-9]{2,8})\b/i) ||
    parts.find((part) => /^[A-Z0-9]{2,6}$/.test(part) && !/^\d+$/.test(part));

  const structuredNick = stripMd(item.username || '');
  const nick =
    structuredNick ||
    (item.author && !/^(tracker|ii tracker)$/i.test(stripMd(item.author))
      ? stripMd(item.author)
      : '') ||
    parts.find(
      (part) =>
        /[a-zA-Z]/.test(part) && !/cosmetic|rare|spotted|room|player|detected|alert/i.test(part),
    ) ||
    'Unknown';

  const trackKind: 'rare' | 'player' = item.track_kind === 'player' ? 'player' : 'rare';

  let cosmetic = stripMd(item.cosmetic || '');
  if (trackKind === 'rare') {
    if (!cosmetic || /spotted|rare cosmetic|detected|alert/i.test(cosmetic)) {
      cosmetic =
        (item.embed_title && !/detected|alert|special cosmetic/i.test(item.embed_title)
          ? stripMd(item.embed_title)
          : '') ||
        parts.find(
          (part) =>
            part !== nick &&
            part !== roomMatch &&
            !/^\d+$/.test(part) &&
            !/^[A-F0-9]{12,}$/i.test(part) &&
            !/player|room|id|region|username|platform|color/i.test(part) &&
            /[a-zA-Z]/.test(part),
        ) ||
        'Rare cosmetic';
    }
  } else {
    cosmetic = '';
  }

  const room = (
    item.room ||
    (typeof roomMatch === 'string' ? roomMatch : roomMatch?.[1] ? roomMatch[1] : '') ||
    ''
  )
    .trim()
    .toUpperCase();
  const playerId = (item.player_id || idMatch?.[1] || '').trim().toUpperCase();
  const region = (item.region || '').trim().toUpperCase();
  let color = (item.color || '').trim();
  if (!color) {
    const colorMatch =
      blob.match(/\bcolou?r\s*[:#]?\s*(#?[0-9A-Fa-f]{6}|\d{1,3}(?:[\s,]\s*\d{1,3}){2})\b/i) || null;
    color = colorMatch?.[1]?.trim() || '';
  }
  color = formatPlayerColorLabel(color);
  const stamp = Date.parse(item.timestamp);
  const ageMs = Number.isFinite(stamp) ? Math.max(0, now - stamp) : Number.POSITIVE_INFINITY;

  return {
    id: item.id,
    nick: stripMd(nick),
    playerId,
    room,
    region,
    cosmetic: cosmetic.slice(0, 80),
    color,
    platform: (item.platform || '').trim(),
    trackKind,
    avatar: item.avatar,
    timestamp: item.timestamp,
    ageMs,
    haystack: [nick, playerId, room, region, cosmetic, color, trackKind, blob]
      .join(' ')
      .toLowerCase(),
  };
}

function TrackerError({
  message,
  adminDetail,
  isStaff,
}: {
  message: string;
  adminDetail: string | null;
  isStaff: boolean;
}) {
  return (
    <div className="tracker-error" role="alert">
      <p>{message}</p>
      {isStaff && adminDetail && (
        <pre className="tracker-error-admin" aria-label="Admin error detail">
          {adminDetail}
        </pre>
      )}
    </div>
  );
}

function PlayerCard({
  hit,
  newest = false,
  jumping = false,
  focused = false,
  index = 0,
  action,
  onCopied,
}: {
  hit: ParsedHit;
  newest?: boolean;
  jumping?: boolean;
  focused?: boolean;
  index?: number;
  action?: ReactNode;
  onCopied?: (label: string) => void;
}) {
  const rare = hit.trackKind === 'rare';
  const colorCss = playerColorCss(hit.color);
  const colorLabel = formatPlayerColorLabel(hit.color);
  const className = [
    'tracker-card',
    rare ? 'tracker-card-rare' : 'tracker-card-player',
    newest ? 'tracker-card-newest' : '',
    jumping ? 'tracker-card-jump' : '',
    focused ? 'tracker-card-focused' : '',
    colorCss ? 'has-player-color' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const copyValue = async (value: string, label: string) => {
    if (await copyText(value)) onCopied?.(label);
  };

  return (
    <li
      className={className}
      style={
        {
          animationDelay: jumping ? '0ms' : `${Math.min(index, 18) * 24}ms`,
          ...(colorCss ? { ['--player-color']: colorCss } : {}),
        } as CSSProperties
      }
    >
      <div className="tracker-card-top">
        <div className="tracker-card-identity">
          <div className="tracker-card-avatar" aria-hidden="true">
            {hit.avatar ? (
              <img src={hit.avatar} alt="" />
            ) : (
              <EngineIcon name={rare ? 'tracker' : 'trackerUser'} size={26} />
            )}
          </div>
          <div className="tracker-card-name-block">
            <div className="tracker-card-name-row">
              <button
                type="button"
                className="tracker-card-name tracker-copy-btn"
                title={`Copy name ${hit.nick}`}
                onClick={() => void copyValue(hit.nick, 'Name copied')}
              >
                {hit.nick}
              </button>
              {newest ? <span className="tracker-card-badge">Newest</span> : null}
            </div>
            <span className={`tracker-card-room ${hit.room ? '' : 'is-empty'}`}>
              <EngineIcon name="trackerRoom" size={14} />
              {hit.room ? (
                <button
                  type="button"
                  className="tracker-card-room-code tracker-copy-btn"
                  title={`Copy room ${hit.room}`}
                  onClick={() => void copyValue(hit.room, 'Room code copied')}
                >
                  {hit.room}
                </button>
              ) : (
                'No room yet'
              )}
            </span>
            {rare && hit.cosmetic ? (
              <span className="tracker-card-cosmetic">{hit.cosmetic}</span>
            ) : null}
          </div>
        </div>
        <time dateTime={hit.timestamp} className="tracker-card-time">
          <span className="tracker-card-live-dot" aria-hidden="true" />
          {formatSeen(hit.timestamp)}
        </time>
      </div>
      <div className="tracker-card-tags">
        {hit.playerId ? (
          <button
            type="button"
            className="tracker-card-tag tracker-card-tag-id"
            title={`Copy player ID ${hit.playerId}`}
            onClick={() => void copyValue(hit.playerId, 'Player ID copied')}
          >
            <EngineIcon name="trackerId" size={12} />
            <span className="tracker-card-id-label">ID</span>
            <span className="tracker-card-id-value">{hit.playerId}</span>
          </button>
        ) : (
          <span className="tracker-card-tag tracker-card-tag-muted">No ID</span>
        )}
        {colorLabel ? (
          <button
            type="button"
            className="tracker-card-tag tracker-card-tag-color"
            title={`Copy color ${colorLabel}`}
            onClick={() => void copyValue(colorLabel, 'Color copied')}
          >
            <span
              className="tracker-card-color-swatch"
              style={colorCss ? { background: colorCss } : undefined}
              aria-hidden="true"
            />
            <span className="tracker-card-id-label">Color</span>
            <span className="tracker-card-id-value">{colorLabel}</span>
          </button>
        ) : null}
        {hit.region ? (
          <span className="tracker-card-tag">
            <EngineIcon name="tracker" size={12} />
            {hit.region}
          </span>
        ) : null}
        {hit.platform ? <span className="tracker-card-tag">{hit.platform}</span> : null}
      </div>
      {action ? <div className="tracker-card-actions">{action}</div> : null}
    </li>
  );
}

function TargetMatchCard({
  hit,
  watching,
  onWatch,
  index = 0,
}: {
  hit: ParsedHit;
  watching: boolean;
  onWatch: () => void;
  index?: number;
}) {
  const canWatch = Boolean(watchKeyForHit(hit));
  return (
    <li
      className={`target-match-card ${watching ? 'is-watching' : ''}`}
      style={{ animationDelay: `${Math.min(index, 18) * 24}ms` }}
    >
      <button
        type="button"
        className="target-match-hitbox"
        onClick={() => {
          if (!canWatch) return;
          onWatch();
        }}
        disabled={!canWatch}
        aria-label={
          watching
            ? `Stop watching ${hit.nick}`
            : canWatch
              ? `Add ${hit.nick} to watchlist`
              : `${hit.nick} has no ID to watch`
        }
      >
        <div className="target-match-main">
          <div className="tracker-card-avatar" aria-hidden="true">
            {hit.avatar ? (
              <img src={hit.avatar} alt="" />
            ) : (
              <EngineIcon name="trackerUser" size={26} />
            )}
          </div>
          <div className="target-match-copy">
            <div className="target-match-title-row">
              <strong className="tracker-card-name">{hit.nick}</strong>
              <time dateTime={hit.timestamp} className="tracker-card-time">
                <span className="tracker-card-live-dot" aria-hidden="true" />
                {formatSeen(hit.timestamp)}
              </time>
            </div>
            <div className="target-match-meta">
              {hit.playerId ? (
                <span title={hit.playerId}>
                  <EngineIcon name="trackerId" size={12} />
                  {hit.playerId}
                </span>
              ) : (
                <span className="tracker-card-tag-muted">No ID</span>
              )}
              {hit.color ? (
                <span title={formatPlayerColorLabel(hit.color)}>
                  <span
                    className="tracker-card-color-swatch"
                    style={
                      playerColorCss(hit.color)
                        ? { background: playerColorCss(hit.color)! }
                        : undefined
                    }
                    aria-hidden="true"
                  />
                  {formatPlayerColorLabel(hit.color)}
                </span>
              ) : null}
              {hit.room ? (
                <span>
                  <EngineIcon name="trackerRoom" size={12} />
                  {hit.room}
                </span>
              ) : null}
              {hit.region ? (
                <span>
                  <EngineIcon name="tracker" size={12} />
                  {hit.region}
                </span>
              ) : null}
            </div>
            {hit.cosmetic ? <p className="target-match-cosmetic">{hit.cosmetic}</p> : null}
          </div>
        </div>
        <span className={`target-match-cta ${watching ? 'is-active' : ''}`}>
          {watching ? (
            <>
              <UserMinus size={14} strokeWidth={2.25} aria-hidden="true" />
              Watching
            </>
          ) : (
            <>
              <UserPlus size={14} strokeWidth={2.25} aria-hidden="true" />
              Add to watchlist
            </>
          )}
        </span>
      </button>
    </li>
  );
}

function WatchlistMemberCard({
  target,
  onlineHit,
  onRemove,
}: {
  target: WatchTarget;
  onlineHit?: ParsedHit | null;
  onRemove: () => void;
}) {
  const cosmetic = onlineHit?.cosmetic || target.cosmetic || '';
  const room = onlineHit?.room || target.room || '';
  const region = onlineHit?.region || target.region || '';
  const online = Boolean(onlineHit);
  return (
    <li className={`target-watch-card ${online ? 'is-online' : ''}`}>
      <div className="tracker-card-avatar" aria-hidden="true">
        <EngineIcon name="trackerUser" size={26} />
      </div>
      <div className="target-watch-copy">
        <div className="target-match-title-row">
          <strong className="tracker-card-name">{stripMd(target.nick)}</strong>
          <span className={`target-online-pill ${online ? 'is-on' : ''}`}>
            <span className="tracker-card-live-dot" aria-hidden="true" />
            {online ? `Online · ${formatSeen(onlineHit!.timestamp)}` : 'Offline'}
          </span>
        </div>
        <div className="target-match-meta">
          <span title={target.playerId}>
            <EngineIcon name="trackerId" size={12} />
            {target.playerId.startsWith('NICK:') ? 'No ID' : target.playerId}
          </span>
          {(onlineHit?.color || '').trim() ? (
            <span title={formatPlayerColorLabel(onlineHit!.color)}>
              <span
                className="tracker-card-color-swatch"
                style={
                  playerColorCss(onlineHit!.color)
                    ? { background: playerColorCss(onlineHit!.color)! }
                    : undefined
                }
                aria-hidden="true"
              />
              {formatPlayerColorLabel(onlineHit!.color)}
            </span>
          ) : null}
          {room ? (
            <span>
              <EngineIcon name="trackerRoom" size={12} />
              {room}
            </span>
          ) : null}
          {region ? (
            <span>
              <EngineIcon name="tracker" size={12} />
              {region}
            </span>
          ) : null}
        </div>
        {cosmetic ? <p className="target-match-cosmetic">{cosmetic}</p> : null}
      </div>
      <button
        type="button"
        className="tracker-watch-remove"
        aria-label={`Remove ${target.nick} from watchlist`}
        onClick={onRemove}
      >
        <X size={15} strokeWidth={2.35} aria-hidden="true" />
      </button>
    </li>
  );
}

export default function Tracker({
  mode = 'player',
  demo = false,
  hasIiTracker = false,
  hasIiTrackerBeta = false,
  isStaff = false,
  navigate,
}: {
  mode?: TrackerMode;
  demo?: boolean;
  isPro?: boolean;
  hasIiTracker?: boolean;
  hasIiTrackerBeta?: boolean;
  isStaff?: boolean;
  navigate?: (page: Page) => void;
}) {
  const owned = hasIiTracker || hasIiTrackerBeta;
  const previewDemo = owned && (demo || (!!import.meta.env.DEV && !isTauri()));
  const unlocked = owned;
  const liveBeta = previewDemo || hasIiTrackerBeta;
  const [feedItems, setFeedItems] = useState<TrackerFeedItem[]>([]);
  const [feedNotice, setFeedNotice] = useState('');
  const [feedError, setFeedError] = useState('');
  const [feedAdminDetail, setFeedAdminDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessionToken, setSessionToken] = useState('');
  const [pulseKey, setPulseKey] = useState(0);
  const [jumpIds, setJumpIds] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [targetQuery, setTargetQuery] = useState('');
  const [playerFilter, setPlayerFilter] = useState<PlayerBoardFilter>({ kind: 'all' });
  const [lookbackSeconds, setLookbackSeconds] = useState(readStoredLookbackSeconds);
  const [viewMode, setViewMode] = useState<PlayerViewMode>(readStoredViewMode);
  const [focusPlayerId, setFocusPlayerId] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [watchlist, setWatchlist] = useState(() => readWatchlist());
  const [historyTick, setHistoryTick] = useState(0);
  const [manualId, setManualId] = useState('');
  const [manualNick, setManualNick] = useState('');
  const [manualNotice, setManualNotice] = useState('');
  const [copyToast, setCopyToast] = useState('');
  const copyToastTimer = useRef<number | null>(null);
  const deferredQuery = useDeferredValue(query);
  const showCopied = useCallback((label: string) => {
    setCopyToast(label);
    if (copyToastTimer.current) window.clearTimeout(copyToastTimer.current);
    copyToastTimer.current = window.setTimeout(() => setCopyToast(''), 1600);
  }, []);
  const deferredTargetQuery = useDeferredValue(targetQuery);
  const targetSearchRef = useRef<HTMLInputElement | null>(null);
  const manualIdRef = useRef<HTMLInputElement | null>(null);
  const playersSectionRef = useRef<HTMLElement | null>(null);
  const cosmeticsSectionRef = useRef<HTMLElement | null>(null);
  const raresSectionRef = useRef<HTMLElement | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const feedPrimedRef = useRef(false);
  const demoIndexRef = useRef(0);
  const lookbackRef = useRef(lookbackSeconds);
  const feedCountRef = useRef(0);
  const feedModes = mode === 'player' || mode === 'target';

  useEffect(() => {
    trackFeature(
      'tracker',
      mode === 'self' ? 'open_self' : mode === 'target' ? 'open_target' : 'open_player',
    );
  }, [mode]);

  useEffect(() => {
    if (!feedModes || !liveBeta) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [feedModes, liveBeta]);

  useEffect(() => {
    if (mode !== 'player') return;
    if (!feedPrimedRef.current) {
      for (const item of feedItems) seenIdsRef.current.add(item.id);
      feedPrimedRef.current = true;
      return;
    }
    const freshRare: string[] = [];
    const freshPlayers: string[] = [];
    for (const item of feedItems) {
      if (seenIdsRef.current.has(item.id)) continue;
      seenIdsRef.current.add(item.id);
      if (item.track_kind === 'player') freshPlayers.push(item.id);
      else freshRare.push(item.id);
    }
    if (freshRare.length) setPulseKey((n) => n + 1);
    if (freshPlayers.length) {
      setJumpIds((prev) => {
        const next = new Set(prev);
        for (const id of freshPlayers) next.add(id);
        return next;
      });
      window.setTimeout(() => {
        setJumpIds((prev) => {
          if (!prev.size) return prev;
          const next = new Set(prev);
          for (const id of freshPlayers) next.delete(id);
          return next;
        });
      }, 650);
    }
  }, [feedItems, mode]);

  const ingestFeedItems = useCallback((items: TrackerFeedItem[], opts?: { merge?: boolean }) => {
    setFeedItems((prev) => {
      const source = opts?.merge
        ? (() => {
            const byId = new Map(prev.map((item) => [item.id, item]));
            for (const item of items) byId.set(item.id, item);
            return [...byId.values()];
          })()
        : items;
      return mergeLiveWithRareStore(source);
    });
    mergeSightingHistory(items);
    setHistoryTick((n) => n + 1);
    setNow(Date.now());
    return items;
  }, []);

  useEffect(() => {
    if (!liveBeta || !feedModes || !unlocked) return;
    const history = readSightingHistory();
    if (!history.length) return;
    setFeedItems((prev) => {
      const byId = new Map(prev.map((item) => [item.id, item]));
      let added = 0;
      for (const item of history) {
        if (!byId.has(item.id)) {
          byId.set(item.id, item);
          added += 1;
        }
      }
      return added ? [...byId.values()] : prev;
    });
    setHistoryTick((n) => n + 1);
    setNow(Date.now());
  }, [lookbackSeconds, liveBeta, feedModes, unlocked]);

  const refreshLiveFeed = useCallback(async () => {
    if (!liveBeta || !feedModes) return;
    if (previewDemo) {
      const lookbackChanged = lookbackRef.current !== lookbackSeconds;
      lookbackRef.current = lookbackSeconds;
      setFeedItems((prev) => {
        const seed = DEMO_POOL[demoIndexRef.current % DEMO_POOL.length];
        demoIndexRef.current += 1;
        const cap = boardCapForLookback(lookbackSeconds);
        const next: TrackerFeedItem = {
          ...seed,
          id: `demo-${Date.now()}-${demoIndexRef.current}`,
          timestamp: new Date().toISOString(),
        };
        const buildSeed = () =>
          Array.from({ length: Math.min(cap, DEMO_POOL.length * 8) }, (_, index) => {
            const row = DEMO_POOL[index % DEMO_POOL.length];
            const ageMs = Math.min(
              lookbackSeconds * 1000 - 1_000,
              row.track_kind === 'rare'
                ? index === 0
                  ? 90_000
                  : 75 * 60_000 + index * 45_000
                : (index + 1) * Math.max(20_000, Math.floor((lookbackSeconds * 1000) / cap)),
            );
            return {
              ...row,
              id: `demo-seed-${lookbackSeconds}-${index}`,
              player_id: row.player_id
                ? `${row.player_id.slice(0, 12)}${(index % 16).toString(16).toUpperCase()}${index}`
                    .replace(/[^A-F0-9]/gi, '')
                    .slice(0, 16)
                : row.player_id,
              username: index < DEMO_POOL.length ? row.username : `${row.username}-${index}`,
              room: row.room ? `${row.room}${index % 7 || ''}`.slice(0, 6) : row.room,
              timestamp: new Date(Date.now() - Math.max(0, ageMs)).toISOString(),
            } satisfies TrackerFeedItem;
          });
        const seeded =
          !prev.length || lookbackChanged ? buildSeed() : [next, ...prev].slice(0, cap);
        const board = mergeLiveWithRareStore(seeded);
        mergeSightingHistory(seeded);
        setHistoryTick((n) => n + 1);
        return board;
      });
      setFeedNotice('');
      setFeedError('');
      setFeedAdminDetail(null);
      setNow(Date.now());
      return;
    }
    if (feedCountRef.current === 0) setBusy(true);
    try {
      let token = sessionToken;
      if (!token) {
        const session = await issueTrackerSession();
        token = session.token;
        setSessionToken(token);
      }
      let payload;
      try {
        payload = await fetchTrackerFeed(token, lookbackSeconds);
      } catch (reason) {
        const status = (reason as { status?: number }).status;
        if (status === 401) {
          const session = await issueTrackerSession();
          token = session.token;
          setSessionToken(token);
          payload = await fetchTrackerFeed(token, lookbackSeconds);
        } else if (status === 0) {
          await new Promise((resolve) => window.setTimeout(resolve, 700));
          payload = await fetchTrackerFeed(token, lookbackSeconds);
        } else {
          throw reason;
        }
      }
      ingestFeedItems(payload.items, { merge: true });
      feedCountRef.current = Math.max(feedCountRef.current, payload.items.length);
      setFeedError('');
      if (!payload.live || !payload.enabled) {
        setFeedNotice(payload.reason || 'Feed is off.');
        setFeedAdminDetail(null);
      } else if (payload.unavailable) {
        setFeedNotice(payload.reason || 'Feed is down for a bit.');
        const hint = payload.admin_hint;
        setFeedAdminDetail(
          hint
            ? [
                payload.bot_issue ? 'bot/channel' : 'feed',
                hint.kind || null,
                hint.discord_http_status != null
                  ? `discord HTTP ${hint.discord_http_status}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : payload.bot_issue
              ? 'bot/channel'
              : null,
        );
      } else if (!payload.items.length && !readRareStore().length && feedCountRef.current === 0) {
        setFeedNotice(mode === 'target' ? '' : 'Quiet right now — no hits yet.');
        setFeedAdminDetail(null);
      } else {
        setFeedNotice('');
        setFeedAdminDetail(null);
      }
    } catch (reason) {
      const detail = adminErrorDetail(reason);
      const message = errorMessage(reason, 'Could not load the player tracker feed.');
      setFeedItems((prev) => {
        if (prev.length) {
          setFeedNotice(message);
          setFeedError('');
          setFeedAdminDetail(detail);
          return prev;
        }
        setFeedError(message);
        setFeedAdminDetail(detail);
        setFeedNotice('');
        return prev;
      });
    } finally {
      setBusy(false);
    }
  }, [previewDemo, liveBeta, feedModes, mode, sessionToken, lookbackSeconds, ingestFeedItems]);

  const rateLimited = isDiscordRateLimitedMessage(feedNotice, feedAdminDetail);

  useEffect(() => {
    if (!liveBeta || !feedModes) return;
    void refreshLiveFeed();
    const pollMs = rateLimited ? RATE_LIMIT_POLL_MS : FEED_POLL_MS;
    const timer = window.setInterval(() => void refreshLiveFeed(), pollMs);
    return () => window.clearInterval(timer);
  }, [liveBeta, feedModes, refreshLiveFeed, rateLimited]);

  useEffect(() => {
    try {
      localStorage.setItem(LOOKBACK_STORE_KEY, String(lookbackSeconds));
    } catch {}
  }, [lookbackSeconds]);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_MODE_STORE_KEY, viewMode);
    } catch {}
  }, [viewMode]);

  const lookbackLabel =
    LOOKBACK_OPTIONS.find((option) => option.seconds === lookbackSeconds)?.label ||
    'Selected window';

  const sightingHistory = useMemo(() => {
    void historyTick;
    return readSightingHistory();
  }, [historyTick]);

  const hits = useMemo(() => {
    const lookbackMs = lookbackSeconds * 1000;
    const cap = boardCapForLookback(lookbackSeconds);
    const byId = new Map<string, TrackerFeedItem>();
    for (const item of feedItems) byId.set(item.id, item);
    for (const item of sightingHistory) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
    return [...byId.values()]
      .map((item) => parseHit(item, now))
      .filter((hit) => {
        if (hit.trackKind === 'rare') return hit.ageMs <= RARE_KEEP_MS;
        return hit.ageMs <= lookbackMs;
      })
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, cap);
  }, [feedItems, sightingHistory, now, lookbackSeconds]);

  const regions = useMemo(() => {
    const set = new Set<string>();
    for (const hit of hits) {
      if (hit.region) set.add(hit.region);
    }
    return [...set].sort();
  }, [hits]);

  const rooms = useMemo(() => {
    const set = new Set<string>();
    for (const hit of hits) {
      if (hit.room) set.add(hit.room);
    }
    return [...set].sort();
  }, [hits]);

  const filteredHits = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return hits.filter((hit) => {
      if (playerFilter.kind === 'cosmetics') {
        if (hit.trackKind !== 'rare') return false;
      } else if (playerFilter.kind === 'region') {
        if (hit.region !== playerFilter.value) return false;
      } else if (playerFilter.kind === 'room') {
        if (hit.room !== playerFilter.value) return false;
      }
      if (q && !hit.haystack.includes(q)) return false;
      return true;
    });
  }, [deferredQuery, hits, playerFilter]);

  const featuredRares = useMemo(
    () => filteredHits.filter((hit) => hit.trackKind === 'rare' && hit.ageMs < RARE_FEATURED_MS),
    [filteredHits],
  );
  const playerHits = useMemo(() => {
    const best = new Map<string, ParsedHit>();
    for (const hit of filteredHits) {
      if (hit.trackKind !== 'player') continue;
      const key = hit.playerId || hit.nick.toLowerCase();
      const prev = best.get(key);
      if (!prev || Date.parse(hit.timestamp) > Date.parse(prev.timestamp)) best.set(key, hit);
    }
    return [...best.values()].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  }, [filteredHits]);
  const playerGroups = useMemo(
    () =>
      groupPlayerHits(
        playerHits.map((hit) => ({
          id: hit.id,
          nick: hit.nick,
          playerId: hit.playerId,
          room: hit.room,
          region: hit.region,
          color: hit.color,
          timestamp: hit.timestamp,
        })),
        viewMode,
      ),
    [playerHits, viewMode],
  );
  const hitsById = useMemo(() => new Map(playerHits.map((hit) => [hit.id, hit])), [playerHits]);
  const rareArchive = useMemo(
    () =>
      filteredHits.filter(
        (hit) =>
          hit.trackKind === 'rare' && hit.ageMs >= RARE_FEATURED_MS && hit.ageMs <= RARE_KEEP_MS,
      ),
    [filteredHits],
  );

  const playerCount = playerHits.length;
  const roomCount = useMemo(
    () => new Set(playerHits.map((hit) => hit.room).filter(Boolean)).size,
    [playerHits],
  );
  const regionCount = useMemo(
    () => new Set(playerHits.map((hit) => hit.region).filter(Boolean)).size,
    [playerHits],
  );
  const newestRareId = featuredRares[0]?.id ?? null;
  const updatedLabel = rateLimited
    ? 'Rate limited — retrying every 3s…'
    : busy
      ? 'Updating…'
      : 'Updated just now';
  const hasBoard = featuredRares.length > 0 || playerHits.length > 0 || rareArchive.length > 0;

  const targetSearchHits = useMemo(() => {
    if (mode !== 'target') return [] as ParsedHit[];
    return searchSightings(deferredTargetQuery, sightingHistory, now).map((item) =>
      parseHit(item, now),
    );
  }, [mode, deferredTargetQuery, sightingHistory, now]);

  const watchedOnlineHits = useMemo(() => {
    if (mode !== 'target') return [] as ParsedHit[];
    const latestByKey = new Map<string, ParsedHit>();
    const consider = (hit: ParsedHit) => {
      if (hit.ageMs > WATCH_ONLINE_MS) return;
      const keys = [watchKeyForHit(hit), hit.playerId].filter(Boolean);
      for (const key of keys) {
        const prev = latestByKey.get(key);
        if (!prev || Date.parse(hit.timestamp) > Date.parse(prev.timestamp)) {
          latestByKey.set(key, hit);
        }
      }
    };
    for (const item of sightingHistory) consider(parseHit(item, now));
    for (const item of feedItems) consider(parseHit(item, now));
    return watchlist
      .map((target) => latestByKey.get(target.playerId.toUpperCase()))
      .filter((hit): hit is ParsedHit => !!hit)
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  }, [mode, sightingHistory, feedItems, watchlist, now]);

  useEffect(() => {
    const intent = consumeTrackerNavIntent();
    if (!intent) return;
    if (intent.page === 'Target Tracker' && mode === 'target') {
      if (intent.playerId) {
        setTargetQuery(intent.playerId);
        setFocusPlayerId(intent.playerId);
        if (intent.watch) {
          setWatchlist(
            addWatchTarget({
              playerId: intent.playerId,
              nick: intent.playerId,
            }),
          );
        }
      } else if (intent.query) {
        setTargetQuery(intent.query);
      }
      window.setTimeout(() => targetSearchRef.current?.focus(), 80);
      return;
    }
    if (intent.page === 'Tracker' && mode === 'player') {
      if (intent.room) {
        setPlayerFilter({ kind: 'room', value: intent.room });
        setQuery(intent.room);
      } else if (intent.playerId) {
        setPlayerFilter({ kind: 'all' });
        setQuery(intent.playerId);
        setFocusPlayerId(intent.playerId);
      } else if (intent.query) {
        setQuery(intent.query);
      }
      if (intent.section === 'cosmetics') setPlayerFilter({ kind: 'cosmetics' });
      window.setTimeout(() => {
        const ref =
          intent.section === 'cosmetics'
            ? cosmeticsSectionRef
            : intent.section === 'rares'
              ? raresSectionRef
              : playersSectionRef;
        ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 80);
    }
  }, [mode]);

  const toggleWatch = useCallback((hit: ParsedHit) => {
    const key = watchKeyForHit(hit);
    if (!key) return;
    if (isWatched(key)) {
      setWatchlist(removeWatchTarget(key));
      trackFeature('tracker', 'unwatch_target');
      return;
    }
    setWatchlist(
      addWatchTarget({
        playerId: key,
        nick: hit.nick,
        cosmetic: hit.cosmetic || undefined,
        room: hit.room || undefined,
        region: hit.region || undefined,
      }),
    );
    trackFeature('tracker', 'watch_target');
  }, []);

  const focusTargetSearch = useCallback(() => {
    targetSearchRef.current?.focus();
    targetSearchRef.current?.select();
  }, []);

  const focusManualAdd = useCallback(() => {
    manualIdRef.current?.focus();
    manualIdRef.current?.select();
  }, []);

  const addManualWatch = useCallback((rawId: string, rawNick = '') => {
    const playerId = normalizeManualPlayerId(rawId);
    if (!isPlausiblePlayerId(playerId)) {
      setManualNotice('Enter a player ID (8–32 hex characters).');
      return false;
    }
    if (isWatched(playerId)) {
      setManualNotice(`${playerId} is already on your watchlist.`);
      setManualId(playerId);
      return false;
    }
    const nick = stripMd(rawNick).trim() || playerId;
    setWatchlist(
      addWatchTarget({
        playerId,
        nick,
      }),
    );
    setManualId('');
    setManualNick('');
    setManualNotice(`Watching ${nick}. They’ll show live if the tracker ever finds them.`);
    trackFeature('tracker', 'watch_manual');
    return true;
  }, []);

  const onlineById = useMemo(() => {
    const map = new Map<string, ParsedHit>();
    for (const hit of watchedOnlineHits) {
      const key = watchKeyForHit(hit);
      if (key) map.set(key, hit);
      if (hit.playerId) map.set(hit.playerId, hit);
    }
    return map;
  }, [watchedOnlineHits]);

  if (mode === 'self') {
    return (
      <div className="tracker-page tracker-mode-self">
        <TrackerNodeBackdrop />
        <div className="tracker-shell tracker-shell-simple">
          <header className="tracker-top">
            <div className="tracker-brand">
              <h1>Self Tracker</h1>
            </div>
          </header>
          <div className="tracker-unavailable" role="status">
            <h2>Temporarily unavailable</h2>
            <p>We’re fixing a few issues. Check back later.</p>
          </div>
        </div>
      </div>
    );
  }

  if (!unlocked && (mode === 'player' || mode === 'target')) {
    return (
      <div
        className={`tracker-page tracker-mode-${mode} tracker-page-locked`}
        aria-label={mode === 'target' ? 'Target Tracker' : 'Player Tracker'}
      >
        <TrackerNodeBackdrop />
        <TrackerPaywall product={mode} navigate={navigate} />
      </div>
    );
  }

  if (mode === 'target') {
    return (
      <div className="tracker-page tracker-mode-target">
        <TrackerNodeBackdrop pulseKey={pulseKey} />
        {copyToast ? (
          <div className="tracker-copy-toast" role="status" aria-live="polite">
            {copyToast}
          </div>
        ) : null}
        <div className={`tracker-shell ${liveBeta ? 'tracker-shell-air' : ''}`}>
          <header className="tracker-top tracker-top-player target-top">
            <div className="tracker-brand tracker-brand-row">
              <span className="target-brand-mark" aria-hidden="true">
                <EngineIcon name="targetTracker" size={22} />
              </span>
              <h1>Target Tracker</h1>
              {liveBeta ? (
                <>
                  <span className="tracker-count-pill">
                    <EngineIcon name="targetTracker" size={14} />
                    {watchedOnlineHits.length} online
                  </span>
                  <span className="tracker-live-line">{updatedLabel}</span>
                </>
              ) : (
                <p>Personal watchlist for lobby players — beta tracker role only.</p>
              )}
            </div>
          </header>

          {liveBeta ? (
            <section className="tracker-board target-board" aria-label="Target tracker">
              <div className="target-toolbar">
                <label className="tracker-search target-search">
                  <Search size={15} aria-hidden="true" />
                  <input
                    ref={targetSearchRef}
                    type="text"
                    value={targetQuery}
                    onChange={(event) => setTargetQuery(event.target.value)}
                    placeholder="Search the last 3 days"
                    aria-label="Search past tracker sightings"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {targetQuery ? (
                    <button
                      type="button"
                      className="target-search-clear"
                      aria-label="Clear search"
                      onClick={() => setTargetQuery('')}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                </label>
                <button
                  type="button"
                  className="tracker-icon-btn"
                  disabled={busy}
                  onClick={() => void refreshLiveFeed()}
                  aria-label="Refresh target tracker"
                >
                  <RefreshCw size={15} />
                </button>
                <ul className="tracker-stat-row target-stat-row" aria-label="Target summary">
                  <li>{watchlist.length} watched</li>
                  <li>{watchedOnlineHits.length} online now</li>
                  <li>{sightingHistory.length} sightings (3d)</li>
                </ul>
              </div>

              {feedError && (
                <TrackerError message={feedError} adminDetail={feedAdminDetail} isStaff={isStaff} />
              )}
              {!feedError && feedNotice && (
                <TrackerError
                  message={feedNotice}
                  adminDetail={feedAdminDetail}
                  isStaff={isStaff}
                />
              )}

              <div className="target-layout">
                <div className="target-col target-col-watch">
                  <section className="target-panel" aria-label="Your watchlist">
                    <header className="target-panel-head">
                      <div>
                        <h2>
                          <EngineIcon name="trackerUser" size={16} />
                          Your watchlist
                        </h2>
                        <p>Players on your list — name, ID, and cosmetics</p>
                      </div>
                      <button
                        type="button"
                        className="target-ghost-btn"
                        onClick={focusTargetSearch}
                      >
                        <Search size={14} aria-hidden="true" />
                        Search past sightings
                      </button>
                    </header>
                    {watchlist.length ? (
                      <ul className="target-watch-list">
                        {watchlist.map((target) => (
                          <WatchlistMemberCard
                            key={target.playerId}
                            target={target}
                            onlineHit={onlineById.get(target.playerId.toUpperCase()) || null}
                            onRemove={() => setWatchlist(removeWatchTarget(target.playerId))}
                          />
                        ))}
                      </ul>
                    ) : (
                      <div className="target-empty" role="status">
                        <div className="target-empty-mark" aria-hidden="true">
                          <EngineIcon name="targetTracker" size={42} />
                        </div>
                        <p>
                          Your watchlist is empty. Search past sightings, or add a player ID even if
                          they haven’t shown up yet — they’ll go live here when the tracker finds
                          them.
                        </p>
                        <div className="target-empty-actions">
                          <button
                            type="button"
                            className="target-ghost-btn"
                            onClick={focusTargetSearch}
                          >
                            <Search size={14} aria-hidden="true" />
                            Search past sightings
                          </button>
                          <button
                            type="button"
                            className="target-ghost-btn"
                            onClick={focusManualAdd}
                          >
                            <UserPlus size={14} aria-hidden="true" />
                            Add by ID
                          </button>
                        </div>
                      </div>
                    )}
                  </section>

                  <section
                    className="target-panel target-panel-live"
                    aria-label="Live tracked players"
                  >
                    <header className="target-panel-head">
                      <div>
                        <h2>
                          <EngineIcon name="tracker" size={16} />
                          Live tracked players
                        </h2>
                        <p>
                          Watched players spotted in the last {Math.round(WATCH_ONLINE_MS / 60_000)}
                          m
                        </p>
                      </div>
                    </header>
                    {watchedOnlineHits.length ? (
                      <ul className="tracker-card-grid target-live-grid">
                        {watchedOnlineHits.map((hit, index) => (
                          <PlayerCard
                            key={`live-${hit.playerId || hit.id}`}
                            hit={hit}
                            jumping={jumpIds.has(hit.id)}
                            index={index}
                            onCopied={showCopied}
                          />
                        ))}
                      </ul>
                    ) : (
                      <p className="tracker-status" role="status">
                        {watchlist.length
                          ? 'Nobody on your list is online right now.'
                          : 'Add someone to your watchlist to track them live.'}
                      </p>
                    )}
                  </section>
                </div>

                <section className="target-panel target-col-matches" aria-label="Recent matches">
                  <header className="target-panel-head">
                    <div>
                      <h2>
                        <Clock size={16} aria-hidden="true" />
                        Recent matches
                      </h2>
                      <p>Search the last 3 days, or add anyone by ID</p>
                    </div>
                  </header>

                  <form
                    className="target-manual-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      addManualWatch(manualId, manualNick);
                    }}
                  >
                    <p className="target-manual-label">Add player (even if not seen yet)</p>
                    <div className="target-manual-row">
                      <label className="target-manual-field">
                        <span>Player ID</span>
                        <input
                          ref={manualIdRef}
                          value={manualId}
                          onChange={(event) => {
                            setManualId(event.target.value);
                            setManualNotice('');
                          }}
                          placeholder="e.g. A1B2C3D4E5F60718"
                          autoComplete="off"
                          spellCheck={false}
                          aria-label="Player ID to watch"
                        />
                      </label>
                      <label className="target-manual-field">
                        <span>Name (optional)</span>
                        <input
                          value={manualNick}
                          onChange={(event) => {
                            setManualNick(event.target.value);
                            setManualNotice('');
                          }}
                          placeholder="Display name"
                          autoComplete="off"
                          spellCheck={false}
                          aria-label="Optional display name"
                        />
                      </label>
                      <button type="submit" className="target-manual-submit">
                        <UserPlus size={15} aria-hidden="true" />
                        Watch
                      </button>
                    </div>
                    {manualNotice ? (
                      <p className="target-manual-notice" role="status">
                        {manualNotice}
                      </p>
                    ) : (
                      <p className="target-manual-hint">
                        They stay on your list offline and appear under Live when the tracker spots
                        that ID.
                      </p>
                    )}
                  </form>

                  {deferredTargetQuery.trim() ? (
                    targetSearchHits.length ? (
                      <ul className="target-match-list">
                        {targetSearchHits.map((hit, index) => {
                          const key = watchKeyForHit(hit);
                          const watching = key
                            ? watchlist.some((row) => row.playerId.toUpperCase() === key)
                            : false;
                          return (
                            <TargetMatchCard
                              key={`search-${key || hit.id}`}
                              hit={hit}
                              watching={watching}
                              onWatch={() => toggleWatch(hit)}
                              index={index}
                            />
                          );
                        })}
                      </ul>
                    ) : (
                      <div className="target-no-match" role="status">
                        <p className="tracker-status">
                          No past-day hits match that ID, room, or name.
                        </p>
                        {isPlausiblePlayerId(normalizeManualPlayerId(deferredTargetQuery)) ? (
                          <button
                            type="button"
                            className="target-manual-submit"
                            onClick={() => {
                              const id = normalizeManualPlayerId(deferredTargetQuery);
                              setManualId(id);
                              addManualWatch(id, manualNick || deferredTargetQuery);
                            }}
                          >
                            <UserPlus size={15} aria-hidden="true" />
                            Watch {normalizeManualPlayerId(deferredTargetQuery)} anyway
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="target-ghost-btn"
                            onClick={() => {
                              setManualNick(deferredTargetQuery.trim());
                              focusManualAdd();
                            }}
                          >
                            <UserPlus size={14} aria-hidden="true" />
                            Add by player ID instead
                          </button>
                        )}
                      </div>
                    )
                  ) : (
                    <div className="target-empty target-empty-soft" role="status">
                      <EngineIcon name="trackerId" size={22} />
                      <p>
                        Search by ID, room, or name — or paste an ID above to watch someone the feed
                        hasn’t seen yet.
                      </p>
                    </div>
                  )}
                </section>
              </div>
            </section>
          ) : (
            <div className="tracker-player-soon">
              <p className="tracker-scan-status" aria-live="polite">
                <span className="tracker-scan-dot" aria-hidden="true" />
                Beta only
              </p>
              <h2>Target Tracker</h2>
              <p>
                Search the past 3 days of lobby sightings by ID, room code, or name, then watch
                specific players. Your personal list only lights up when they come online — and only
                on your Engine. Needs the beta ii tracker role.
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="tracker-page tracker-mode-player">
      <TrackerNodeBackdrop pulseKey={pulseKey} />
      {copyToast ? (
        <div className="tracker-copy-toast" role="status" aria-live="polite">
          {copyToast}
        </div>
      ) : null}

      <div className={`tracker-shell ${liveBeta ? 'tracker-shell-air' : ''}`}>
        <header className="tracker-top tracker-top-player">
          <div className="tracker-brand tracker-brand-row">
            <h1>Player Tracker</h1>
            {liveBeta ? (
              <span className="tracker-count-pill">
                <span className="tracker-card-live-dot" aria-hidden="true" />
                {playerCount} player{playerCount === 1 ? '' : 's'}
              </span>
            ) : (
              <p>Rare fits and lobby players spotted in public rooms.</p>
            )}
          </div>
          {liveBeta && (
            <div className="tracker-toolbar">
              <label className="tracker-search">
                <Search size={15} aria-hidden="true" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search player, ID, room…"
                  aria-label="Search tracked players"
                />
              </label>
              <button
                type="button"
                className="tracker-icon-btn"
                disabled={busy}
                onClick={() => void refreshLiveFeed()}
                aria-label="Refresh tracker"
              >
                <RefreshCw size={15} />
              </button>
            </div>
          )}
        </header>

        {liveBeta ? (
          <section className="tracker-board" aria-label="Tracked players">
            <div className="tracker-status-bar">
              <p className="tracker-live-line">
                <span className="tracker-live-waves" aria-hidden="true">
                  (( • ))
                </span>
                {lookbackLabel} · {updatedLabel}
              </p>
              <ul className="tracker-stat-row" aria-label="Lobby summary">
                <li>{playerCount} players</li>
                <li>{roomCount} active rooms</li>
                <li>{regionCount} regions</li>
              </ul>
            </div>

            <div
              className="tracker-filter-row tracker-lookback-row"
              role="tablist"
              aria-label="Tracker time window"
            >
              {LOOKBACK_OPTIONS.map((option) => (
                <button
                  key={option.seconds}
                  type="button"
                  role="tab"
                  aria-selected={lookbackSeconds === option.seconds}
                  className={`tracker-filter-chip ${
                    lookbackSeconds === option.seconds ? 'is-active' : ''
                  }`}
                  onClick={() => setLookbackSeconds(option.seconds)}
                  title={option.label}
                >
                  {option.short}
                </button>
              ))}
              <span className="tracker-lookback-hint">Board window max 3 hours</span>
            </div>

            <div className="tracker-filter-row" role="tablist" aria-label="Tracker filters">
              <button
                type="button"
                role="tab"
                aria-selected={playerFilter.kind === 'all'}
                className={`tracker-filter-chip ${playerFilter.kind === 'all' ? 'is-active' : ''}`}
                onClick={() => setPlayerFilter({ kind: 'all' })}
              >
                All
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={playerFilter.kind === 'cosmetics'}
                className={`tracker-filter-chip ${playerFilter.kind === 'cosmetics' ? 'is-active' : ''}`}
                onClick={() => setPlayerFilter({ kind: 'cosmetics' })}
              >
                Special cosmetics
              </button>
              {regions.map((region) => (
                <button
                  key={`region-${region}`}
                  type="button"
                  role="tab"
                  aria-selected={playerFilter.kind === 'region' && playerFilter.value === region}
                  className={`tracker-filter-chip ${
                    playerFilter.kind === 'region' && playerFilter.value === region
                      ? 'is-active'
                      : ''
                  }`}
                  onClick={() => setPlayerFilter({ kind: 'region', value: region })}
                >
                  {region}
                </button>
              ))}
              {rooms.map((room) => (
                <button
                  key={`room-${room}`}
                  type="button"
                  role="tab"
                  aria-selected={playerFilter.kind === 'room' && playerFilter.value === room}
                  className={`tracker-filter-chip ${
                    playerFilter.kind === 'room' && playerFilter.value === room ? 'is-active' : ''
                  }`}
                  onClick={() => setPlayerFilter({ kind: 'room', value: room })}
                >
                  {room}
                </button>
              ))}
            </div>

            <div
              className="tracker-filter-row tracker-view-row"
              role="tablist"
              aria-label="Player board layout"
            >
              <span className="tracker-view-label">View</span>
              {PLAYER_VIEW_MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  role="tab"
                  aria-selected={viewMode === mode.id}
                  className={`tracker-filter-chip ${viewMode === mode.id ? 'is-active' : ''}`}
                  title={mode.hint}
                  onClick={() => setViewMode(mode.id)}
                >
                  {mode.label}
                </button>
              ))}
            </div>

            {feedError && (
              <TrackerError message={feedError} adminDetail={feedAdminDetail} isStaff={isStaff} />
            )}
            {!feedError && feedNotice && hasBoard && !query.trim() && (
              <TrackerError message={feedNotice} adminDetail={feedAdminDetail} isStaff={isStaff} />
            )}

            {hasBoard ? (
              <div className="tracker-sections">
                {featuredRares.length > 0 && (
                  <section
                    ref={cosmeticsSectionRef}
                    className="tracker-section"
                    aria-label="Rare cosmetics — live"
                  >
                    <header className="tracker-section-head">
                      <h2>Rare cosmetics</h2>
                      <p>Pinned for 10 minutes</p>
                    </header>
                    <ul className="tracker-card-grid tracker-card-grid-rare">
                      {featuredRares.map((hit, index) => (
                        <PlayerCard
                          key={hit.id}
                          hit={hit}
                          newest={hit.id === newestRareId}
                          index={index}
                          focused={!!focusPlayerId && hit.playerId === focusPlayerId}
                          onCopied={showCopied}
                        />
                      ))}
                    </ul>
                  </section>
                )}

                {playerFilter.kind !== 'cosmetics' && (
                  <section
                    ref={playersSectionRef}
                    className="tracker-section tracker-section-players"
                    aria-label="Players in lobbies"
                  >
                    <header className="tracker-section-head">
                      <h2>
                        {viewMode === 'rooms'
                          ? 'Players by room'
                          : viewMode === 'regions'
                            ? 'Players by region'
                            : viewMode === 'colors'
                              ? 'Players by similar color'
                              : 'Players'}
                      </h2>
                      <p>
                        {lookbackLabel} of public lobby sightings
                        {viewMode === 'colors' ? ' · clusters within ±20 RGB' : ''}
                      </p>
                    </header>
                    <div className="tracker-players-panel">
                      {playerHits.length ? (
                        viewMode === 'list' ? (
                          <ul className="tracker-card-grid">
                            {playerHits.map((hit, index) => (
                              <PlayerCard
                                key={hit.id}
                                hit={hit}
                                jumping={jumpIds.has(hit.id)}
                                index={index}
                                focused={!!focusPlayerId && hit.playerId === focusPlayerId}
                                onCopied={showCopied}
                              />
                            ))}
                          </ul>
                        ) : (
                          <div className="tracker-group-stack">
                            {playerGroups.map((group) => (
                              <section
                                key={group.key}
                                className="tracker-group"
                                style={
                                  group.colorCss
                                    ? ({ ['--player-color']: group.colorCss } as CSSProperties)
                                    : undefined
                                }
                              >
                                <header className="tracker-group-head">
                                  {group.colorCss ? (
                                    <span
                                      className="tracker-card-color-swatch tracker-group-swatch"
                                      style={{ background: group.colorCss }}
                                      aria-hidden="true"
                                    />
                                  ) : null}
                                  <div>
                                    <h3>{group.title}</h3>
                                    <p>{group.subtitle}</p>
                                  </div>
                                </header>
                                <ul className="tracker-card-grid">
                                  {group.hits.map((row, index) => {
                                    const hit = hitsById.get(row.id);
                                    if (!hit) return null;
                                    return (
                                      <PlayerCard
                                        key={hit.id}
                                        hit={hit}
                                        jumping={jumpIds.has(hit.id)}
                                        index={index}
                                        focused={!!focusPlayerId && hit.playerId === focusPlayerId}
                                        onCopied={showCopied}
                                      />
                                    );
                                  })}
                                </ul>
                              </section>
                            ))}
                          </div>
                        )
                      ) : (
                        <p className="tracker-status">No lobby players in this view.</p>
                      )}
                    </div>
                  </section>
                )}

                {rareArchive.length > 0 && (
                  <section
                    ref={raresSectionRef}
                    className="tracker-section tracker-section-archive"
                    aria-label="Rare cosmetics archive"
                  >
                    <header className="tracker-section-head">
                      <h2>Recent rares</h2>
                      <p>Kept for 2 days</p>
                    </header>
                    <ul className="tracker-card-grid tracker-card-grid-archive">
                      {rareArchive.map((hit, index) => (
                        <PlayerCard key={hit.id} hit={hit} index={index} onCopied={showCopied} />
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            ) : (
              !feedError && (
                <p className="tracker-status" role="status">
                  {query.trim() || playerFilter.kind !== 'all'
                    ? 'No hits match that filter.'
                    : feedNotice || (busy ? 'Loading…' : 'Waiting on the next hit…')}
                </p>
              )
            )}
          </section>
        ) : (
          <div className="tracker-player-soon">
            <p className="tracker-scan-status" aria-live="polite">
              <span className="tracker-scan-dot" aria-hidden="true" />
              Scanning publics…
            </p>
            <h2>{unlocked ? 'Unlocked — board still dark' : 'ii Tracker'}</h2>
            <p>
              {unlocked
                ? 'Your unlock is on file. Public hits stay off for now. Beta role holders already get live data.'
                : 'Watches publics for rare cosmetics and lobby players. Unlock on Plans, or use the beta tracker role for live hits.'}
            </p>
            {!unlocked && (
              <button
                type="button"
                className="primary tracker-upsell-btn"
                onClick={() => navigate?.('Plans')}
              >
                Plans
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
