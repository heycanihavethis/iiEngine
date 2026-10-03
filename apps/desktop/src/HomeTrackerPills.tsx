import { useEffect, useMemo, useState } from 'react';
import { EngineIcon } from './EngineIcon';
import { homeTrackerModeOptions, type HomeTrackerMode } from './appearance';
import type { Page } from './store';
import { usePreferences } from './store';
import type { TrackerFeedItem } from './trackerApi';
import {
  readSightingHistory,
  readWatchlist,
  WATCH_ONLINE_MS,
  type WatchTarget,
} from './trackerWatch';

type Pill = {
  key: string;
  nick: string;
  detail: string;
  avatar: string | null;
  online?: boolean;
  kind: 'player' | 'rare' | 'target';
};

function formatAgo(timestamp: string) {
  const stamp = Date.parse(timestamp);
  if (!Number.isFinite(stamp)) return '';
  const delta = Math.max(0, Date.now() - stamp);
  if (delta < 45_000) return 'just now';
  if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.max(1, Math.floor(delta / 86_400_000))}d ago`;
}

function nickFromItem(item: TrackerFeedItem) {
  return (item.username || item.author || 'Player').trim() || 'Player';
}

function latestByKind(history: TrackerFeedItem[], kind: 'player' | 'rare', limit: number): Pill[] {
  const best = new Map<string, TrackerFeedItem>();
  for (const item of history) {
    const trackKind = item.track_kind === 'player' ? 'player' : 'rare';
    if (trackKind !== kind) continue;
    const key = (item.player_id || item.username || item.id || '').toUpperCase();
    if (!key) continue;
    const prev = best.get(key);
    if (!prev || Date.parse(item.timestamp) > Date.parse(prev.timestamp)) best.set(key, item);
  }
  return [...best.values()]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, limit)
    .map((item) => ({
      key: item.id || item.player_id || nickFromItem(item),
      nick: nickFromItem(item),
      detail:
        kind === 'rare'
          ? [item.cosmetic || item.embed_title || 'Rare cosmetic', formatAgo(item.timestamp)]
              .filter(Boolean)
              .join(' · ')
          : [item.room, item.region, formatAgo(item.timestamp)].filter(Boolean).join(' · '),
      avatar: item.avatar || null,
      kind,
    }));
}

function targetPills(watchlist: WatchTarget[], history: TrackerFeedItem[], limit: number): Pill[] {
  const now = Date.now();
  const latest = new Map<string, TrackerFeedItem>();
  for (const item of history) {
    const id = (item.player_id || '').toUpperCase();
    if (!id) continue;
    const prev = latest.get(id);
    if (!prev || Date.parse(item.timestamp) > Date.parse(prev.timestamp)) latest.set(id, item);
  }
  return watchlist.slice(0, limit).map((target) => {
    const id = target.playerId.toUpperCase();
    const hit = latest.get(id);
    const age = hit ? now - Date.parse(hit.timestamp) : Number.POSITIVE_INFINITY;
    const online = Number.isFinite(age) && age <= WATCH_ONLINE_MS;
    return {
      key: id,
      nick: target.nick || id,
      detail: online
        ? [hit?.room || target.room, hit?.region || target.region, 'online']
            .filter(Boolean)
            .join(' · ')
        : [target.room || target.region, 'watching'].filter(Boolean).join(' · ') || 'watching',
      avatar: hit?.avatar || null,
      online,
      kind: 'target' as const,
    };
  });
}

export default function HomeTrackerPills({
  demo = false,
  navigate,
  compact = false,
}: {
  demo?: boolean;
  navigate: (page: Page) => void;
  compact?: boolean;
}) {
  const preferences = usePreferences();
  const mode = preferences.appearance.homeTrackerMode;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const pills = useMemo(() => {
    void tick;
    const history = readSightingHistory();
    const limit = compact ? 4 : 8;
    if (mode === 'targets') {
      const watched = readWatchlist();
      if (watched.length) return targetPills(watched, history, limit);
      if (demo) {
        return [
          {
            key: 'demo-target',
            nick: 'GhostFox',
            detail: 'XK7M · USW · online',
            avatar: null,
            online: true,
            kind: 'target' as const,
          },
        ];
      }
      return [];
    }
    const live =
      mode === 'lastRare'
        ? latestByKind(history, 'rare', limit)
        : latestByKind(history, 'player', limit);
    if (live.length) return live;
    if (!demo) return [];
    return mode === 'lastRare'
      ? [
          {
            key: 'demo-rare',
            nick: 'Mira',
            detail: 'Obsidian Wings · just now',
            avatar: null,
            kind: 'rare' as const,
          },
        ]
      : [
          {
            key: 'demo-player',
            nick: 'Volt',
            detail: 'ZZ2A · EU · just now',
            avatar: null,
            kind: 'player' as const,
          },
        ];
  }, [mode, compact, tick, demo]);

  const setMode = (next: HomeTrackerMode) => {
    preferences.setAppearance({ homeTrackerMode: next });
  };

  const openTracker = () => {
    navigate(mode === 'targets' ? 'Target Tracker' : 'Tracker');
  };

  return (
    <section className="dashboard-card home-tracker-card" aria-label="Tracker pills">
      <div className="card-heading">
        <span className="card-heading-glyph">
          <EngineIcon name="tracker" size={19} />
        </span>
        <div className="card-heading-text">
          <h2>Tracker</h2>
          <p>
            {homeTrackerModeOptions.find((option) => option.id === mode)?.blurb ||
              'Recent tracker sightings'}
          </p>
        </div>
        <button type="button" className="home-tracker-open" onClick={openTracker}>
          Open
        </button>
      </div>

      <div className="home-tracker-modes" role="tablist" aria-label="Tracker pill mode">
        {homeTrackerModeOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={mode === option.id}
            className={`home-tracker-mode ${mode === option.id ? 'is-active' : ''}`}
            title={option.blurb}
            onClick={() => setMode(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {pills.length ? (
        <ul className="home-tracker-pill-row">
          {pills.map((pill) => (
            <li key={pill.key}>
              <button
                type="button"
                className={`home-tracker-pill kind-${pill.kind} ${pill.online ? 'is-online' : ''}`}
                onClick={openTracker}
              >
                <span className="home-tracker-pill-avatar" aria-hidden="true">
                  {pill.avatar ? (
                    <img src={pill.avatar} alt="" />
                  ) : (
                    <EngineIcon
                      name={pill.kind === 'rare' ? 'sparkles' : 'trackerUser'}
                      size={14}
                    />
                  )}
                </span>
                <span className="home-tracker-pill-text">
                  <strong>{pill.nick}</strong>
                  <small>{pill.detail}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="home-tracker-empty">
          {mode === 'targets'
            ? 'No Target Tracker players yet — add some on Target Tracker.'
            : mode === 'lastRare'
              ? 'No special cosmetics cached yet. Open Player Tracker to fill this.'
              : 'No lobby players cached yet. Open Player Tracker to fill this.'}
        </p>
      )}
    </section>
  );
}
