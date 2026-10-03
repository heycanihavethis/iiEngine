import { useCallback, useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { EngineIcon } from './EngineIcon';
import { apiRequest, errorMessage } from './api';
import { parseAiChatSse } from './studioAssist';
import { trackFeature } from './telemetry';

export type GameDirEntry = {
  name: string;
  relative: string;
  directory: boolean;
  size: number;
};

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parentRelative(relative: string) {
  const parts = relative.replace(/\\/g, '/').split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

export default function GameFilesBrowser({
  demo,
  isPro,
  gamePath,
  onNeedGame,
}: {
  demo: boolean;
  isPro: boolean;
  gamePath: string | null;
  onNeedGame?: () => Promise<string | null>;
}) {
  const [relative, setRelative] = useState('');
  const [entries, setEntries] = useState<GameDirEntry[]>([]);
  const [selected, setSelected] = useState<GameDirEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiAnswer, setAiAnswer] = useState('');
  const [aiError, setAiError] = useState('');

  const load = useCallback(async (path: string, nextRelative: string) => {
    setBusy(true);
    setError('');
    try {
      const listed = await invoke<GameDirEntry[]>('list_game_directory', {
        gamePath: path,
        relative: nextRelative || null,
      });
      setRelative(nextRelative);
      setEntries(listed);
      setSelected(null);
      setAiAnswer('');
      setAiError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setEntries([]);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (demo || !isTauri() || !gamePath) return;
    void load(gamePath, '');
  }, [demo, gamePath, load]);

  async function ensurePath() {
    if (gamePath) return gamePath;
    const found = (await onNeedGame?.()) ?? null;
    if (!found) throw new Error('Gorilla Tag was not found.');
    return found;
  }

  async function openEntry(entry: GameDirEntry) {
    if (!entry.directory) {
      setSelected(entry);
      setAiAnswer('');
      setAiError('');
      return;
    }
    try {
      const path = await ensurePath();
      await load(path, entry.relative);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function goUp() {
    if (!relative) return;
    try {
      const path = await ensurePath();
      await load(path, parentRelative(relative));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function askAi() {
    if (!selected && !relative) return;
    if (!isPro) {
      setAiError('Ask AI about files is an Engine Pro perk.');
      return;
    }
    setAiBusy(true);
    setAiError('');
    setAiAnswer('');
    const target = selected?.relative || relative || '(Gorilla Tag root)';
    const listing = entries
      .slice(0, 40)
      .map((entry) => `${entry.directory ? '[dir]' : '[file]'} ${entry.name}`)
      .join('\n');
    const prompt = [
      'Explain this Gorilla Tag / BepInEx path for an ii Engine player in 3-6 short sentences.',
      'Say what it is usually for, whether players should edit it, and any caution.',
      'Do not invent malware claims. If unsure, say so.',
      `Path: ${target || '/'}`,
      selected ? `Selected: ${selected.directory ? 'folder' : 'file'} · ${selected.name}` : '',
      listing ? `Nearby entries:\n${listing}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    try {
      if (demo) {
        setAiAnswer(
          `${target || 'This folder'} is part of the Gorilla Tag install tree. In demo mode, sign in on the desktop app with Pro for a live explanation.`,
        );
        trackFeature('health', 'game_files_ai_demo');
        return;
      }
      const response = await apiRequest('/v1/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: prompt, share_telemetry: false }),
        signal: AbortSignal.timeout(60_000),
      });
      const parsed = parseAiChatSse(await response.text());
      if (parsed.error) throw new Error(parsed.error);
      const text = parsed.text.trim();
      if (!text) throw new Error('No answer returned.');
      setAiAnswer(text);
      trackFeature('health', 'game_files_ai');
    } catch (reason) {
      setAiError(errorMessage(reason, 'Could not explain this path.'));
    } finally {
      setAiBusy(false);
    }
  }

  const crumbs = relative ? relative.split('/').filter(Boolean) : [];

  return (
    <section className="engine-card game-files-browser" aria-label="Game files">
      <header className="engine-card-head">
        <EngineIcon name="folder" size={17} className="head-glyph" />
        <div>
          <h2>Game files</h2>
          <p>Browse your Gorilla Tag folder. Pro can ask AI what a path does.</p>
        </div>
      </header>

      {demo || !isTauri() ? (
        <p className="game-files-empty">Open the Windows desktop app to browse local game files.</p>
      ) : !gamePath ? (
        <div className="game-files-empty-actions">
          <p>Scan or detect Gorilla Tag first, then browse from the install root.</p>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              void (async () => {
                const path = await onNeedGame?.();
                if (path) await load(path, '');
              })();
            }}
          >
            Find Gorilla Tag
          </button>
        </div>
      ) : (
        <>
          <div className="game-files-toolbar">
            <button type="button" disabled={busy || !relative} onClick={() => void goUp()}>
              <EngineIcon name="arrowRight" size={14} className="game-files-up" />
              Up
            </button>
            <nav className="game-files-crumbs" aria-label="Current path">
              <button
                type="button"
                disabled={busy || !relative}
                onClick={() => void load(gamePath, '')}
              >
                Gorilla Tag
              </button>
              {crumbs.map((part, index) => {
                const path = crumbs.slice(0, index + 1).join('/');
                return (
                  <span key={path}>
                    <i>/</i>
                    <button
                      type="button"
                      disabled={busy || path === relative}
                      onClick={() => void load(gamePath, path)}
                    >
                      {part}
                    </button>
                  </span>
                );
              })}
            </nav>
            <button
              type="button"
              disabled={busy}
              title="Refresh folder"
              onClick={() => void load(gamePath, relative)}
            >
              <EngineIcon name="refresh" size={14} />
            </button>
          </div>

          {error && (
            <p className="game-files-error" role="status">
              {error}
            </p>
          )}

          <div className="game-files-list" role="list">
            {busy && !entries.length ? (
              <p className="game-files-empty">Loading…</p>
            ) : entries.length === 0 ? (
              <p className="game-files-empty">This folder is empty.</p>
            ) : (
              entries.map((entry) => (
                <button
                  type="button"
                  role="listitem"
                  key={entry.relative}
                  className={`game-files-row ${selected?.relative === entry.relative ? 'selected' : ''}`}
                  onClick={() => void openEntry(entry)}
                  onDoubleClick={() => entry.directory && void openEntry(entry)}
                >
                  <EngineIcon name={entry.directory ? 'folder' : 'mods'} size={15} />
                  <span className="game-files-name">{entry.name}</span>
                  <small>{entry.directory ? 'Folder' : formatSize(entry.size)}</small>
                </button>
              ))
            )}
          </div>

          <div className="game-files-detail">
            <div>
              <strong>
                {selected?.name || (relative ? relative.split('/').pop() : 'Gorilla Tag')}
              </strong>
              <p>
                {selected
                  ? selected.directory
                    ? `Folder · ${selected.relative}`
                    : `File · ${selected.relative}`
                  : relative
                    ? `Browsing ${relative}`
                    : 'Browsing the Gorilla Tag install root'}
              </p>
            </div>
            <button
              type="button"
              className="primary"
              disabled={aiBusy || (!selected && !gamePath)}
              onClick={() => void askAi()}
              title={isPro ? 'Ask Private AI what this path does' : 'Engine Pro required'}
            >
              <EngineIcon name="ai" size={15} />
              {aiBusy ? 'Asking…' : isPro ? 'Ask AI what this is' : 'Ask AI (Pro)'}
            </button>
          </div>

          {aiError && (
            <p className="game-files-error" role="alert">
              {aiError}
            </p>
          )}
          {aiAnswer && (
            <div className="game-files-ai" role="status">
              {aiAnswer}
            </div>
          )}
        </>
      )}
    </section>
  );
}
