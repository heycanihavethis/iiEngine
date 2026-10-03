import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  Copy,
  Database,
  FolderOpen,
  HardDrive,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import PageHero from './PageHero';

type Candidate = { path: string; valid: boolean; missing: string[] };
type Backup = {
  id: string;
  created_at: string;
  operation: string;
  total_bytes: number;
  file_count: number;
  scopes: string[];
  verified: boolean;
  completed: boolean;
  recoverable: boolean;
};
type Preview = {
  token: string;
  backup_id: string;
  backup_created_at: string;
  backup_bytes: number;
  safety_snapshot_bytes: number;
  file_count: number;
  scopes: string[];
};

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export default function Backups({ demo }: { demo: boolean }) {
  const [items, setItems] = useState<Backup[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [editingPath, setEditingPath] = useState(false);
  const [optionsId, setOptionsId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    if (demo || !isTauri()) return;
    setBusy(true);
    setError('');
    try {
      const [backups, games] = await Promise.all([
        invoke<Backup[]>('list_backups'),
        invoke<Candidate[]>('discover_game'),
      ]);
      setItems(backups);
      setCandidates(games);
      setPath((current) => current || games.find((item) => item.valid)?.path || '');
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }, [demo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function prepare(item: Backup) {
    setBusy(true);
    setError('');
    setStatus('Verifying backup and current files…');
    setConfirmed(false);
    try {
      const result = await invoke<Preview>('prepare_restore', {
        gamePath: path,
        backupId: item.id,
      });
      setPreview(result);
      setStatus('Review the restore scope and safety snapshot before continuing.');
    } catch (reason) {
      setStatus('');
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!preview || !confirmed) return;
    setBusy(true);
    setError('');
    setStatus('Creating a safety snapshot and restoring verified files…');
    try {
      const result = await invoke<{ restored_backup_id: string; safety_backup_id: string }>(
        'execute_restore',
        { token: preview.token },
      );
      setStatus(
        `Restore complete. Safety backup ${result.safety_backup_id.slice(0, 8)} was created.`,
      );
      setPreview(null);
      setConfirmed(false);
      await refresh();
    } catch (reason) {
      setStatus('');
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function resume(item: Backup) {
    setBusy(true);
    setError('');
    setStatus('Checking and resuming the interrupted operation…');
    try {
      await invoke('resume_operation', { gamePath: path, operationId: item.id });
      setStatus('Recovery completed and the installed files were verified.');
      await refresh();
    } catch (reason) {
      setStatus('');
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function openFolder() {
    if (!path || !isTauri()) return;
    try {
      await invoke('open_game_folder', { gamePath: path });
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function copyBackupId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setStatus(`Copied backup id ${id.slice(0, 8)}…`);
      setOptionsId(null);
    } catch (reason) {
      setError(String(reason));
    }
  }

  function focusBackupList() {
    listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function focusNeedsAttention() {
    focusBackupList();
    const first = items.find((item) => !item.verified || item.recoverable);
    if (first) setOptionsId(first.id);
  }

  const totalBytes = items.reduce((sum, item) => sum + item.total_bytes, 0);
  const verifiedCount = items.filter((item) => item.verified).length;
  const allVerified = items.length > 0 && verifiedCount === items.length;

  const shell = (
    <>
      <PageHero
        compact
        label="Backups"
        title="Backups"
        subtitle="Save protected files so you can restore them later."
      />

      <section className="panel backup-overview">
        <header>
          <Database size={22} />
          <div>
            <h2>Backup Overview</h2>
            <p>Create and restore verified copies of protected Gorilla Tag files.</p>
          </div>
        </header>
        <div className="backup-stat-grid" role="toolbar" aria-label="Backup shortcuts">
          <button type="button" onClick={() => void refresh()} disabled={busy}>
            <Database size={18} />
            <strong>{demo || !isTauri() ? '-' : verifiedCount}</strong>
            <span>Verified Backups</span>
          </button>
          <button type="button" onClick={() => void openFolder()} disabled={!path || busy}>
            <HardDrive size={18} />
            <strong>{demo || !isTauri() ? '-' : bytes(totalBytes)}</strong>
            <span>Total Size</span>
          </button>
          <button type="button" onClick={focusNeedsAttention} disabled={busy || !items.length}>
            <ShieldCheck size={18} />
            <strong>
              {demo || !isTauri() ? 'Desktop only' : allVerified ? 'All Verified' : 'Review needed'}
            </strong>
            <span>
              {allVerified || demo ? 'No issues detected' : 'Some backups need attention'}
            </span>
          </button>
        </div>
      </section>
    </>
  );

  if (demo || !isTauri()) {
    return (
      <div className="backups-page">
        {shell}
        <section className="panel empty">
          <HardDrive size={32} />
          <h2>Backups stay on this computer</h2>
          <p>
            The desktop app lists verified repair backups and provides reviewed restore actions.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="backups-page">
      {shell}

      <section className="panel backup-path-panel">
        <header>
          <FolderOpen size={18} />
          <div>
            <h3>Gorilla Tag Folder</h3>
            <p>This is the game directory that backups are created from and restored to.</p>
          </div>
        </header>
        <div className="backup-path-row">
          <input
            value={path}
            readOnly={!editingPath}
            onChange={(event) => setPath(event.target.value)}
            aria-label="Gorilla Tag folder"
          />
          <button onClick={() => setEditingPath((value) => !value)}>
            <Pencil size={15} /> {editingPath ? 'Done' : 'Change Path'}
          </button>
          <button disabled={!path} onClick={() => void openFolder()}>
            <FolderOpen size={15} /> Open Folder
          </button>
        </div>
        {candidates.map((candidate) => (
          <button
            className="installation-choice"
            key={candidate.path}
            disabled={!candidate.valid || busy}
            onClick={() => setPath(candidate.path)}
          >
            {candidate.path} {candidate.valid ? '' : `· missing ${candidate.missing.join(', ')}`}
          </button>
        ))}
      </section>

      <section className="panel backup-panel">
        <div className="section-heading">
          <div>
            <h2>Verified Backups</h2>
            <p>Restore creates a safety snapshot before replacing current files.</p>
          </div>
          <button disabled={busy} onClick={refresh}>
            <RefreshCw size={16} /> Refresh
          </button>
        </div>
        {!items.length && !busy && (
          <div className="empty compact-empty">
            <HardDrive size={28} />
            <h3>No backups yet</h3>
            <p>A verified backup appears here after the first install or repair.</p>
          </div>
        )}
        <div className="backup-list" ref={listRef}>
          {items.map((item) => (
            <article className="backup-card" key={item.id}>
              <div className="backup-icon" aria-hidden="true">
                {item.recoverable ? <Wrench size={20} /> : <Database size={20} />}
              </div>
              <div className="backup-card-main">
                <strong>{new Date(item.created_at).toLocaleString()}</strong>
                <p>{item.operation}</p>
              </div>
              <div className="backup-meta">
                <p>
                  {item.file_count} files · {bytes(item.total_bytes)}
                </p>
                <small>Contents and exact scope</small>
              </div>
              <span className={`pill ${item.verified ? '' : 'warning'}`}>
                {item.verified ? (
                  <>
                    <ShieldCheck size={12} /> Verified
                  </>
                ) : (
                  'CHECK FAILED'
                )}
              </span>
              <div className="backup-card-actions">
                {item.completed && item.verified && (
                  <button
                    className="primary"
                    disabled={busy || !path}
                    onClick={() => prepare(item)}
                  >
                    <RotateCcw size={16} /> Prepare Restore
                  </button>
                )}
                {item.recoverable && (
                  <button disabled={busy || !path} onClick={() => resume(item)}>
                    Resume interrupted operation
                  </button>
                )}
                <div className="backup-options">
                  <button
                    className="icon-button"
                    aria-label="Backup options"
                    aria-expanded={optionsId === item.id}
                    onClick={() =>
                      setOptionsId((current) => (current === item.id ? null : item.id))
                    }
                  >
                    <MoreHorizontal size={16} />
                  </button>
                  {optionsId === item.id && (
                    <div className="backup-options-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => void copyBackupId(item.id)}
                      >
                        <Copy size={14} /> Copy backup id
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={!path}
                        onClick={() => {
                          setOptionsId(null);
                          void openFolder();
                        }}
                      >
                        <FolderOpen size={14} /> Open game folder
                      </button>
                      {item.completed && item.verified && (
                        <button
                          type="button"
                          role="menuitem"
                          disabled={busy || !path}
                          onClick={() => {
                            setOptionsId(null);
                            void prepare(item);
                          }}
                        >
                          <RotateCcw size={14} /> Prepare restore
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <details>
                <summary>Contents and exact scope</summary>
                <ul>
                  {item.scopes.map((scope) => (
                    <li key={scope}>{scope}</li>
                  ))}
                </ul>
                <code>{item.id}</code>
              </details>
            </article>
          ))}
        </div>
        {preview && (
          <div className="install-review">
            <h3>
              <ShieldCheck size={18} /> Restore review
            </h3>
            <p>
              Restore {preview.file_count} verified files from{' '}
              {new Date(preview.backup_created_at).toLocaleString()}. The current files require a{' '}
              {bytes(preview.safety_snapshot_bytes)} safety backup first.
            </p>
            <ul>
              {preview.scopes.map((scope) => (
                <li key={scope}>{scope}</li>
              ))}
            </ul>
            <label className="check-choice">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I reviewed these paths and want to replace them with this verified backup.
            </label>
            <button className="primary" disabled={busy || !confirmed} onClick={restore}>
              Create safety backup and restore
            </button>
          </div>
        )}
        {status && <p role="status">{status}</p>}
        {error && <p role="alert">{error}</p>}
      </section>
    </div>
  );
}
