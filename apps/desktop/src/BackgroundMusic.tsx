import { useEffect } from 'react';
import {
  Music2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Upload,
  Volume2,
  VolumeX,
  Trash2,
} from 'lucide-react';
import { bindMusicMediaSession, useMusicStore } from './musicStore';

export default function BackgroundMusic({
  demo = false,
  compact = false,
}: {
  demo?: boolean;
  compact?: boolean;
}) {
  const tracks = useMusicStore((state) => state.tracks);
  const index = useMusicStore((state) => state.index);
  const playing = useMusicStore((state) => state.playing);
  const muted = useMusicStore((state) => state.muted);
  const volume = useMusicStore((state) => state.volume);
  const status = useMusicStore((state) => state.status);
  const setDemo = useMusicStore((state) => state.setDemo);
  const refresh = useMusicStore((state) => state.refresh);
  const setVolume = useMusicStore((state) => state.setVolume);
  const setMuted = useMusicStore((state) => state.setMuted);
  const playAt = useMusicStore((state) => state.playAt);
  const togglePlay = useMusicStore((state) => state.togglePlay);
  const next = useMusicStore((state) => state.next);
  const prev = useMusicStore((state) => state.prev);
  const importFiles = useMusicStore((state) => state.importFiles);
  const removeLocal = useMusicStore((state) => state.removeLocal);

  const current = tracks[index] ?? null;

  useEffect(() => {
    setDemo(demo);
  }, [demo, setDemo]);

  useEffect(() => {
    const unsub = bindMusicMediaSession();
    return unsub;
  }, []);

  return (
    <section
      className={`background-music ${compact ? 'compact' : ''}`}
      aria-label="Background music player"
    >
      <header>
        <strong>
          <Music2 size={16} /> Background music
        </strong>
        <span>Quiet by default · headset next/prev cycles the playlist</span>
      </header>
      <div className="music-now">
        <div>
          <em>{current?.title || 'No tracks yet'}</em>
          <small>
            {current
              ? `${current.artist} · ${current.source === 'local' ? 'Local' : 'Preset'}`
              : 'Import MP3s or use staff presets'}
          </small>
        </div>
        <div className="music-controls">
          <button
            type="button"
            aria-label="Previous track"
            onClick={prev}
            disabled={!tracks.length}
          >
            <SkipBack size={16} />
          </button>
          <button
            type="button"
            className="primary"
            aria-label={playing ? 'Pause' : 'Play'}
            disabled={!tracks.length}
            onClick={togglePlay}
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button type="button" aria-label="Next track" onClick={next} disabled={!tracks.length}>
            <SkipForward size={16} />
          </button>
          <button
            type="button"
            aria-label={muted ? 'Unmute' : 'Mute'}
            onClick={() => setMuted(!muted)}
          >
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <label className="music-volume">
            <span className="sr-only">Volume</span>
            <input
              type="range"
              min={0.04}
              max={0.45}
              step={0.01}
              value={volume}
              onChange={(event) => setVolume(Number(event.target.value))}
            />
          </label>
        </div>
      </div>
      <div className="music-actions">
        <label className="music-import">
          <Upload size={14} /> Import MP3
          <input
            type="file"
            accept="audio/mpeg,audio/mp4,audio/wav,audio/ogg,.mp3,.m4a,.mp4,.wav,.ogg"
            multiple
            hidden
            onChange={(event) => {
              void importFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </label>
        <button type="button" onClick={() => void refresh()}>
          Refresh presets
        </button>
      </div>
      {status && <p role="status">{status}</p>}
      <ul className="music-playlist">
        {tracks.map((track, i) => (
          <li key={track.id} className={i === index ? 'active' : ''}>
            <button type="button" onClick={() => void playAt(i)}>
              <strong>{track.title}</strong>
              <small>
                {track.artist} · {track.source}
              </small>
            </button>
            {track.source === 'local' && (
              <button
                type="button"
                className="text-button"
                aria-label={`Remove ${track.title}`}
                onClick={() => void removeLocal(track.id)}
              >
                <Trash2 size={14} />
              </button>
            )}
          </li>
        ))}
        {!tracks.length && <li className="empty-row">No songs yet. Import an MP3 to start.</li>}
      </ul>
    </section>
  );
}

export { useMusicStore } from './musicStore';
export type { MusicTrack } from './musicLibrary';
