import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { AnimatePresence, motion } from 'motion/react';
import { RefreshCw, Users } from 'lucide-react';
import { errorMessage } from './api';
import { detectGame } from './launcher';
import { trackFeature } from './telemetry';
import {
  clearTrackerPresence,
  getSelfTracker,
  listTrackedPlayers,
  readLocalPresence,
  setSelfTracker,
  upsertTrackerPresence,
  type LocalPresence,
  type TrackedPlayer,
} from './trackerApi';
import type { Page } from './store';

const POLL_MS = 20_000;

function formatSeen(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'Unknown';
  const delta = Math.max(0, Date.now() - parsed);
  if (delta < 45_000) return 'Just now';
  if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(parsed).toLocaleString();
}

function roomLabel(player: TrackedPlayer) {
  if (!player.online) return 'Offline';
  if (player.in_room && player.room_code) return player.room_code;
  return 'Lobby';
}

function statusLabel(player: TrackedPlayer) {
  if (!player.online) return 'Offline';
  if (player.in_room && player.room_code) return 'In room';
  return 'Online';
}

export default function SelfTracker({
  demo = false,
  isPro = false,
  navigate,
}: {
  demo?: boolean;
  isPro?: boolean;
  navigate?: (page: Page) => void;
}) {
  const canOptIn = demo || isPro;
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [gamePath, setGamePath] = useState('');
  const [localPresence, setLocalPresence] = useState<LocalPresence | null>(null);
  const [players, setPlayers] = useState<TrackedPlayer[]>([]);
  const [staleAfter, setStaleAfter] = useState(12 * 60);
  const lastFingerprint = useRef('');

  useEffect(() => {
    trackFeature('tracker', 'open_self');
  }, []);

  const refreshPlayers = useCallback(async () => {
    if (demo) {
      setPlayers([
        {
          user_id: 'demo-1',
          display_name: 'Demo Player',
          username: 'DemoPlayer',
          avatar: null,
          room_code: 'CODE',
          in_room: true,
          updated_at: new Date().toISOString(),
          online: true,
          seconds_ago: 12,
          status: 'in_room',
        },
        {
          user_id: 'demo-2',
          display_name: 'Lobby Friend',
          username: '',
          avatar: null,
          room_code: '',
          in_room: false,
          updated_at: new Date(Date.now() - 90_000).toISOString(),
          online: true,
          seconds_ago: 90,
          status: 'online',
        },
        {
          user_id: 'demo-3',
          display_name: 'Offline Mate',
          username: 'GoneAFK',
          avatar: null,
          room_code: '',
          in_room: false,
          updated_at: new Date(Date.now() - 3_600_000).toISOString(),
          online: false,
          seconds_ago: 3600,
          status: 'offline',
        },
      ]);
      return;
    }
    const payload = await listTrackedPlayers();
    setPlayers(payload.players);
    setStaleAfter(payload.stale_after_seconds);
    if (payload.unavailable) {
      setNotice(
        'Live player list is updating on the server. Sharing still works. Check back shortly.',
      );
    }
  }, [demo]);

  const refreshLocal = useCallback(async (path?: string) => {
    if (!isTauri()) return;
    const flag = await getSelfTracker(path);
    setEnabled(flag.enabled);
    if (!flag.enabled) {
      setLocalPresence(null);
      return;
    }
    const presence = await readLocalPresence(path);
    setLocalPresence(presence);
    if (!presence) return;
    const fingerprint = `${presence.username}|${presence.room_code}|${presence.in_room}|${presence.updated_at}`;
    if (fingerprint === lastFingerprint.current) return;
    lastFingerprint.current = fingerprint;
    await upsertTrackerPresence({
      username: presence.username,
      room_code: presence.room_code,
      in_room: presence.in_room,
      updated_at: presence.updated_at,
    });
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (demo || !isTauri()) {
          if (active) await refreshPlayers();
          return;
        }
        const path = await detectGame();
        if (!active) return;
        setGamePath(path);
        await refreshLocal(path);
        await refreshPlayers();
      } catch (reason) {
        if (active) setError(errorMessage(reason, 'Could not load tracker.'));
      }
    })();
    return () => {
      active = false;
    };
  }, [demo, refreshLocal, refreshPlayers]);

  useEffect(() => {
    if (demo) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          if (enabled && gamePath) await refreshLocal(gamePath);
          await refreshPlayers();
          setError('');
        } catch (reason) {
          setError(errorMessage(reason, 'Tracker refresh failed.'));
        }
      })();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [demo, enabled, gamePath, refreshLocal, refreshPlayers]);

  useEffect(() => {
    if (canOptIn || !enabled) return;
    void (async () => {
      try {
        if (!demo && isTauri()) {
          const path = gamePath || (await detectGame());
          await setSelfTracker(false, path);
          await clearTrackerPresence();
        }
        setEnabled(false);
        setLocalPresence(null);
        lastFingerprint.current = '';
        setNotice('Sharing requires Engine Pro. You were removed from the list.');
      } catch {
        setEnabled(false);
      }
    })();
  }, [canOptIn, demo, enabled, gamePath]);

  async function toggle(next: boolean) {
    if (!canOptIn) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (demo) {
        setEnabled(next);
        setNotice(
          next ? 'You are visible on the live list (demo).' : 'You left the live list (demo).',
        );
        return;
      }
      if (!isTauri()) throw new Error('Sharing requires the Windows desktop app.');
      const path = gamePath || (await detectGame());
      setGamePath(path);
      await setSelfTracker(next, path);
      setEnabled(next);
      if (!next) {
        lastFingerprint.current = '';
        setLocalPresence(null);
        await clearTrackerPresence();
        setNotice('You left the live list.');
      } else {
        setNotice('Sharing on. The menu publishes your room while Gorilla Tag is open.');
        await refreshLocal(path);
      }
      await refreshPlayers();
      trackFeature('tracker', next ? 'enable' : 'disable');
    } catch (reason) {
      setError(errorMessage(reason, 'Could not update sharing.'));
    } finally {
      setBusy(false);
    }
  }

  const visible = useMemo(
    () =>
      [...players].sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        if (a.in_room !== b.in_room) return a.in_room ? -1 : 1;
        return (a.username || a.display_name).localeCompare(b.username || b.display_name);
      }),
    [players],
  );

  const onlineCount = visible.filter((player) => player.online).length;
  const inRoomCount = visible.filter((player) => player.online && player.in_room).length;
  const empty = visible.length === 0;

  return (
    <div className="tracker-page">
      <div className="tracker-shell">
        <header className="tracker-top">
          <div className="tracker-brand">
            <div>
              <h1>Self Tracker</h1>
              <p>Opt in to share your nick and room with other Engine players.</p>
            </div>
          </div>
          <div className="tracker-top-actions">
            <div className="tracker-stat-pills" aria-label="Live counts">
              <span>
                <strong>{onlineCount}</strong> online
              </span>
              <span>
                <strong>{inRoomCount}</strong> in room
              </span>
              <span>
                <strong>{visible.length}</strong> sharing
              </span>
            </div>
            <button
              type="button"
              className="tracker-chip-btn"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  try {
                    if (enabled && gamePath) await refreshLocal(gamePath);
                    await refreshPlayers();
                  } catch (reason) {
                    setError(errorMessage(reason, 'Refresh failed.'));
                  }
                })()
              }
            >
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
        </header>

        <div className="tracker-stage tracker-stage-stacked">
          <section
            className="tracker-presence-panel tracker-presence-compact"
            aria-label="Your presence"
          >
            <div className="tracker-presence-row">
              <div className="tracker-presence-copy">
                <h2>
                  {enabled ? 'You are live' : 'Share my presence'}
                  <span className="tiny">PRO</span>
                </h2>
                <p>
                  {canOptIn
                    ? `When on, the menu publishes your nick and room. Drops after ~${Math.round(staleAfter / 60)} min idle.`
                    : 'Upgrade to Engine Pro to appear on the live list. Everyone can still browse who’s sharing.'}
                </p>
              </div>
              {canOptIn ? (
                <label className={`tracker-switch ${enabled ? 'on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={busy}
                    onChange={(event) => void toggle(event.target.checked)}
                  />
                  <span>{enabled ? 'Sharing' : 'Hidden'}</span>
                </label>
              ) : (
                <button
                  type="button"
                  className="primary tracker-upsell-btn"
                  onClick={() => navigate?.('Plans')}
                >
                  See Pro plans
                </button>
              )}
            </div>
            {localPresence && enabled && (
              <div className="tracker-presence-meta">
                <div>
                  <span>In-game</span>
                  <strong>{localPresence.username || 'Waiting…'}</strong>
                </div>
                <div>
                  <span>Room</span>
                  <strong>
                    {localPresence.in_room && localPresence.room_code
                      ? localPresence.room_code
                      : 'Not in a room'}
                  </strong>
                </div>
                <div>
                  <span>Updated</span>
                  <strong>{formatSeen(localPresence.updated_at)}</strong>
                </div>
              </div>
            )}
            {notice && (
              <p className="tracker-status" role="status">
                {notice}
              </p>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </section>

          <aside className="tracker-roster-panel" aria-label="Who is sharing">
            <div className="tracker-roster-head">
              <div>
                <h3>Who’s here</h3>
                <p>Opted-in Engine players and rooms. Live board.</p>
              </div>
              <Users size={18} aria-hidden="true" className="tracker-roster-icon" />
            </div>

            <AnimatePresence mode="wait">
              {empty ? (
                <motion.div
                  key="empty"
                  className="tracker-empty-panel"
                  role="status"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                >
                  <Users size={28} strokeWidth={1.5} aria-hidden="true" />
                  <h3>Nobody is here right now</h3>
                  <p>Check back later. When players share their presence, they’ll show up here.</p>
                </motion.div>
              ) : (
                <motion.ul
                  key="roster"
                  className="tracker-roster"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  {visible.map((player) => {
                    const nick = player.username || 'No nick yet';
                    const status = statusLabel(player);
                    return (
                      <li key={player.user_id} className={player.online ? 'online' : 'offline'}>
                        <div className="tracker-avatar" aria-hidden="true">
                          {player.avatar ? (
                            <img src={player.avatar} alt="" />
                          ) : (
                            <span>{(player.display_name || nick).slice(0, 1).toUpperCase()}</span>
                          )}
                        </div>
                        <div className="tracker-roster-main">
                          <div className="tracker-roster-top">
                            <strong>{nick}</strong>
                            <span
                              className={`tracker-chip ${player.status || status.toLowerCase().replace(/\s+/g, '-')}`}
                            >
                              {status}
                            </span>
                          </div>
                          <div className="tracker-roster-sub">
                            <span>{player.display_name || 'Discord hidden'}</span>
                            <span className="tracker-sep" aria-hidden="true">
                              ·
                            </span>
                            <span className="tracker-code">{roomLabel(player)}</span>
                            <span className="tracker-sep" aria-hidden="true">
                              ·
                            </span>
                            <span>{formatSeen(player.updated_at)}</span>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </motion.ul>
              )}
            </AnimatePresence>
          </aside>
        </div>
      </div>
    </div>
  );
}
