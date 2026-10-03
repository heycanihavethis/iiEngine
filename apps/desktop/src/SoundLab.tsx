import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { AnimatePresence, motion } from 'motion/react';
import {
  Disc3,
  FolderOpen,
  Pause,
  Play,
  Power,
  RefreshCw,
  SkipBack,
  SkipForward,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
} from 'lucide-react';
import { detectGame } from './launcher';
import { errorMessage } from './api';
import { trackFeature } from './telemetry';
import { useMusicStore } from './musicStore';
import type { Page } from './store';

export type MenuSoundFx = {
  bass: number;
  volume: number;
  speed: number;
  distortion: number;
  pitch: number;
  reverb: number;
};

type MenuSoundEntry = {
  filename: string;
  byte_size: number;
  enabled: boolean;
  media: string;
  fx: MenuSoundFx;
};

type LabTab = 'playlist' | 'menu';

const FX_DEFAULT: MenuSoundFx = {
  bass: 0.35,
  volume: 1,
  speed: 1,
  distortion: 0,
  pitch: 0,
  reverb: 0.15,
};

const FX_SLIDERS = [
  ['bass', 'Bass', 0, 1, 0.01],
  ['volume', 'Volume', 0, 1.2, 0.01],
  ['speed', 'Speed', 0.5, 1.8, 0.01],
  ['distortion', 'Distortion', 0, 1, 0.01],
  ['pitch', 'Pitch', -1, 1, 0.01],
  ['reverb', 'Reverb', 0, 1, 0.01],
] as const;

const DEMO_MENU_SOUNDS: MenuSoundEntry[] = [
  {
    filename: 'button.mp3',
    byte_size: 48_000,
    enabled: true,
    media: 'mp3',
    fx: { ...FX_DEFAULT, bass: 0.4 },
  },
  {
    filename: 'click.mp3',
    byte_size: 32_000,
    enabled: true,
    media: 'mp3',
    fx: { ...FX_DEFAULT, speed: 1.05 },
  },
  {
    filename: 'whoosh.mp3',
    byte_size: 96_000,
    enabled: false,
    media: 'mp3',
    fx: { ...FX_DEFAULT, reverb: 0.4, pitch: 0.2 },
  },
];

const size = (bytes: number) =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(2)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function makeDistortionCurve(amount: number) {
  const samples = 256;
  const curve = new Float32Array(samples);
  const k = Math.max(0, amount) * 100;
  for (let i = 0; i < samples; i += 1) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

function Visualizer({ active }: { active: boolean }) {
  return (
    <div className={`soundlab-viz ${active ? 'live' : ''}`} aria-hidden="true">
      {Array.from({ length: 24 }, (_, i) => (
        <span key={i} style={{ animationDelay: `${(i % 8) * 0.08}s` }} />
      ))}
    </div>
  );
}

export default function SoundLab({
  isPro,
  navigate,
  demo,
}: {
  isPro: boolean;
  navigate: (page: Page) => void;
  demo: boolean;
}) {
  const tracks = useMusicStore((s) => s.tracks);
  const index = useMusicStore((s) => s.index);
  const playing = useMusicStore((s) => s.playing);
  const volume = useMusicStore((s) => s.volume);
  const status = useMusicStore((s) => s.status);
  const setDemo = useMusicStore((s) => s.setDemo);
  const setVolume = useMusicStore((s) => s.setVolume);
  const playAt = useMusicStore((s) => s.playAt);
  const togglePlay = useMusicStore((s) => s.togglePlay);
  const next = useMusicStore((s) => s.next);
  const prev = useMusicStore((s) => s.prev);
  const importFiles = useMusicStore((s) => s.importFiles);
  const removeLocal = useMusicStore((s) => s.removeLocal);
  const refreshMusic = useMusicStore((s) => s.refresh);

  const [tab, setTab] = useState<LabTab>('menu');
  const [gamePath, setGamePath] = useState('');
  const [menuSounds, setMenuSounds] = useState<MenuSoundEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draftFx, setDraftFx] = useState<MenuSoundFx>(FX_DEFAULT);
  const [menuStatus, setMenuStatus] = useState('');
  const [menuBusy, setMenuBusy] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const previewNodesRef = useRef<{ stop: () => void } | null>(null);

  useEffect(() => {
    trackFeature('soundlab', 'open');
  }, []);

  useEffect(() => {
    setDemo(demo);
  }, [demo, setDemo]);

  useEffect(() => {
    void refreshMusic();
  }, [refreshMusic]);

  const loadGame = useCallback(async () => {
    if (demo || !isTauri()) {
      setMenuSounds(DEMO_MENU_SOUNDS.map((item) => ({ ...item, fx: { ...item.fx } })));
      setSelected(DEMO_MENU_SOUNDS[0]?.filename ?? null);
      setMenuStatus(
        demo
          ? 'Sample menu sounds. FX and enable/disable work here. The desktop app writes to your Gorilla Tag Sounds folder.'
          : 'Menu sound folder editing requires the desktop app and a Gorilla Tag install.',
      );
      setGamePath('');
      return;
    }
    try {
      const path = await detectGame();
      setGamePath(path);
      setMenuStatus('');
    } catch (error) {
      setMenuStatus(errorMessage(error, 'Could not find Gorilla Tag.'));
      setMenuSounds([]);
    }
  }, [demo]);

  const refreshMenuSounds = useCallback(async () => {
    if (demo || !isTauri()) {
      setMenuSounds(DEMO_MENU_SOUNDS.map((item) => ({ ...item, fx: { ...item.fx } })));
      return;
    }
    if (!gamePath) return;
    setMenuBusy(true);
    try {
      const items = await invoke<MenuSoundEntry[]>('list_menu_sounds', { gamePath });
      setMenuSounds(items);
      if (selected && !items.some((item) => item.filename === selected)) {
        setSelected(items[0]?.filename ?? null);
      } else if (!selected && items[0]) {
        setSelected(items[0].filename);
      }
    } catch (error) {
      setMenuStatus(errorMessage(error, 'Could not list menu sounds.'));
    } finally {
      setMenuBusy(false);
    }
  }, [demo, gamePath, selected]);

  useEffect(() => {
    void loadGame();
  }, [loadGame]);

  useEffect(() => {
    if (gamePath) void refreshMenuSounds();
  }, [gamePath, refreshMenuSounds]);

  const selectedEntry = useMemo(
    () => menuSounds.find((item) => item.filename === selected) ?? null,
    [menuSounds, selected],
  );

  useEffect(() => {
    if (selectedEntry) setDraftFx(selectedEntry.fx);
  }, [selectedEntry]);

  const stopPreview = useCallback(() => {
    previewNodesRef.current?.stop();
    previewNodesRef.current = null;
    setPreviewPlaying(false);
  }, []);

  const startDemoPreview = useCallback(async () => {
    stopPreview();
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') await ctx.resume();
    const duration = 1.6;
    const sampleRate = ctx.sampleRate;
    const frameCount = Math.floor(sampleRate * duration);
    const buffer = ctx.createBuffer(1, frameCount, sampleRate);
    const data = buffer.getChannelData(0);
    const hz = 420 * Math.pow(2, draftFx.pitch * 0.5);
    for (let i = 0; i < frameCount; i += 1) {
      const t = i / sampleRate;
      const env = Math.min(1, t * 8) * Math.min(1, (duration - t) * 4);
      data[i] = Math.sin(2 * Math.PI * hz * t * draftFx.speed) * 0.22 * env;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = draftFx.speed;

    const gain = ctx.createGain();
    gain.gain.value = Math.min(1.4, Math.max(0, draftFx.volume * 0.85));
    const bass = ctx.createBiquadFilter();
    bass.type = 'lowshelf';
    bass.frequency.value = 180;
    bass.gain.value = draftFx.bass * 18;
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeDistortionCurve(draftFx.distortion);
    shaper.oversample = '4x';
    const wet = ctx.createGain();
    wet.gain.value = draftFx.reverb * 0.55;
    const dry = ctx.createGain();
    dry.gain.value = 1 - draftFx.reverb * 0.35;
    const delay = ctx.createDelay(0.6);
    delay.delayTime.value = 0.14;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.35;
    delay.connect(feedback);
    feedback.connect(delay);

    source.connect(bass);
    bass.connect(shaper);
    shaper.connect(dry);
    shaper.connect(delay);
    delay.connect(wet);
    dry.connect(gain);
    wet.connect(gain);
    gain.connect(ctx.destination);
    source.start();
    setPreviewPlaying(true);
    previewNodesRef.current = {
      stop: () => {
        try {
          source.stop();
        } catch {}
        source.disconnect();
      },
    };
    source.onended = () => {
      setPreviewPlaying(false);
      previewNodesRef.current = null;
    };
  }, [draftFx, stopPreview]);

  const startPreview = useCallback(async () => {
    if (!selectedEntry) return;
    if (demo || !gamePath || !isTauri()) {
      await startDemoPreview();
      return;
    }
    stopPreview();
    setMenuBusy(true);
    try {
      const bytes = await invoke<number[]>('read_menu_sound_bytes', {
        gamePath,
        filename: selectedEntry.filename,
      });
      const buffer = new Uint8Array(bytes);
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') await ctx.resume();
      const decoded = await ctx.decodeAudioData(buffer.buffer.slice(0));
      const source = ctx.createBufferSource();
      source.buffer = decoded;
      source.playbackRate.value = draftFx.speed * (1 + draftFx.pitch * 0.06);

      const gain = ctx.createGain();
      gain.gain.value = Math.min(1.4, Math.max(0, draftFx.volume * 0.85));
      const bass = ctx.createBiquadFilter();
      bass.type = 'lowshelf';
      bass.frequency.value = 180;
      bass.gain.value = draftFx.bass * 18;
      const shaper = ctx.createWaveShaper();
      shaper.curve = makeDistortionCurve(draftFx.distortion);
      shaper.oversample = '4x';
      const wet = ctx.createGain();
      wet.gain.value = draftFx.reverb * 0.55;
      const dry = ctx.createGain();
      dry.gain.value = 1 - draftFx.reverb * 0.35;
      const delay = ctx.createDelay(0.6);
      delay.delayTime.value = 0.14;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.35;
      delay.connect(feedback);
      feedback.connect(delay);

      source.connect(bass);
      bass.connect(shaper);
      shaper.connect(dry);
      shaper.connect(delay);
      delay.connect(wet);
      dry.connect(gain);
      wet.connect(gain);
      gain.connect(ctx.destination);

      source.start();
      setPreviewPlaying(true);
      previewNodesRef.current = {
        stop: () => {
          try {
            source.stop();
          } catch {}
          source.disconnect();
        },
      };
      source.onended = () => {
        setPreviewPlaying(false);
        previewNodesRef.current = null;
      };
    } catch (error) {
      setMenuStatus(errorMessage(error, 'Preview failed for that sound.'));
    } finally {
      setMenuBusy(false);
    }
  }, [demo, draftFx, gamePath, selectedEntry, startDemoPreview, stopPreview]);

  useEffect(() => () => stopPreview(), [stopPreview]);

  async function persistFx(nextFx: MenuSoundFx) {
    if (!selectedEntry) return;
    setDraftFx(nextFx);
    if (demo || !gamePath || !isTauri()) {
      setMenuSounds((items) =>
        items.map((item) =>
          item.filename === selectedEntry.filename ? { ...item, fx: nextFx } : item,
        ),
      );
      return;
    }
    try {
      await invoke('update_menu_sound_fx', {
        gamePath,
        filename: selectedEntry.filename,
        fx: nextFx,
      });
      setMenuSounds((items) =>
        items.map((item) =>
          item.filename === selectedEntry.filename ? { ...item, fx: nextFx } : item,
        ),
      );
      trackFeature('soundlab', 'fx_save');
    } catch (error) {
      setMenuStatus(errorMessage(error, 'Could not save FX settings.'));
    }
  }

  async function toggleEnabled(entry: MenuSoundEntry) {
    if (demo || !gamePath || !isTauri()) {
      setMenuSounds((items) =>
        items.map((item) =>
          item.filename === entry.filename ? { ...item, enabled: !item.enabled } : item,
        ),
      );
      return;
    }
    setMenuBusy(true);
    try {
      await invoke('set_menu_sound_enabled', {
        gamePath,
        filename: entry.filename,
        enabled: !entry.enabled,
      });
      await refreshMenuSounds();
      trackFeature('soundlab', entry.enabled ? 'disable_menu_sound' : 'enable_menu_sound');
    } catch (error) {
      setMenuStatus(errorMessage(error, 'Could not change sound state.'));
    } finally {
      setMenuBusy(false);
    }
  }

  async function uploadMenuSound(files: FileList | null) {
    if (!files?.length) return;
    if (demo || !gamePath || !isTauri()) {
      setMenuStatus('Uploading to the Sounds folder needs the desktop app and Gorilla Tag.');
      return;
    }
    setMenuBusy(true);
    try {
      for (const file of Array.from(files)) {
        const lower = file.name.toLowerCase();
        if (!lower.endsWith('.mp3') && !lower.endsWith('.mp4')) {
          setMenuStatus('Menu uploads must be MP3 or MP4.');
          continue;
        }
        if (file.size > 40 * 1024 * 1024) {
          setMenuStatus(`${file.name} is over 40 MB.`);
          continue;
        }
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
        await invoke('import_menu_sound', { gamePath, filename: file.name, bytes });
      }
      await refreshMenuSounds();
      trackFeature('soundlab', 'upload_menu_sound');
    } catch (error) {
      setMenuStatus(errorMessage(error, 'Upload failed.'));
    } finally {
      setMenuBusy(false);
    }
  }

  if (!isPro) {
    return (
      <div className="soundlab-page soundlab-upsell">
        <motion.div
          className="soundlab-shell soundlab-upsell-card"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <span className="eyebrow">Pro</span>
          <h1>SoundLab</h1>
          <p>Background playlists and menu sounds with live FX.</p>
          <button type="button" className="primary" onClick={() => navigate('Plans')}>
            See Pro plans
          </button>
        </motion.div>
      </div>
    );
  }

  const currentTrack = tracks[index];

  return (
    <div className="soundlab-page">
      <div className="soundlab-shell">
        <header className="soundlab-top">
          <div className="soundlab-brand">
            <div>
              <h1>SoundLab</h1>
              <p>Engine background playlist and ii Reborn Menu sound files.</p>
            </div>
          </div>
          <nav className="soundlab-tabs" aria-label="SoundLab modes">
            <button
              type="button"
              className={tab === 'playlist' ? 'active' : ''}
              aria-pressed={tab === 'playlist'}
              onClick={() => setTab('playlist')}
            >
              <Disc3 size={16} /> Engine playlist
            </button>
            <button
              type="button"
              className={tab === 'menu' ? 'active' : ''}
              aria-pressed={tab === 'menu'}
              onClick={() => setTab('menu')}
            >
              <FolderOpen size={16} /> Menu sounds
            </button>
          </nav>
        </header>

        <AnimatePresence mode="wait">
          {tab === 'playlist' ? (
            <motion.section
              key="playlist"
              className="soundlab-stage"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.22 }}
            >
              <div className="soundlab-player">
                <Visualizer active={playing} />
                <div className="soundlab-now-playing">
                  <p className="eyebrow">NOW PLAYING</p>
                  <h2>{currentTrack?.title || 'Nothing queued'}</h2>
                  <p>
                    {currentTrack
                      ? `${currentTrack.artist} · ${
                          currentTrack.source === 'disk'
                            ? 'EnginePlaylist folder'
                            : currentTrack.source === 'local'
                              ? 'Your library'
                              : 'Preset'
                        }`
                      : 'Import an MP3 into iisStupidMenu/EnginePlaylist (separate from Menu Sounds).'}
                  </p>
                </div>
                <div className="soundlab-transport-bar">
                  <button
                    type="button"
                    aria-label="Previous"
                    onClick={prev}
                    disabled={!tracks.length}
                  >
                    <SkipBack size={18} />
                  </button>
                  <button
                    type="button"
                    className="soundlab-play"
                    aria-label={playing ? 'Pause' : 'Play'}
                    disabled={!tracks.length}
                    onClick={() => togglePlay()}
                  >
                    {playing ? <Pause size={22} /> : <Play size={22} />}
                  </button>
                  <button type="button" aria-label="Next" onClick={next} disabled={!tracks.length}>
                    <SkipForward size={18} />
                  </button>
                </div>
                <label className="soundlab-volume">
                  <Volume2 size={16} />
                  <input
                    type="range"
                    min={0.04}
                    max={0.45}
                    step={0.01}
                    value={volume}
                    onChange={(event) => setVolume(Number(event.target.value))}
                  />
                  <span>{Math.round(volume * 100)}</span>
                </label>
                {status ? (
                  <p className="soundlab-status" role="status">
                    {status}
                  </p>
                ) : null}
              </div>

              <aside className="soundlab-library">
                <div className="soundlab-library-head">
                  <div>
                    <h3>Library</h3>
                    <p>Stored in iisStupidMenu/EnginePlaylist — not the Menu Sounds folder.</p>
                  </div>
                  <div className="soundlab-library-actions">
                    <label className="soundlab-chip-btn">
                      <Upload size={14} /> Import
                      <input
                        type="file"
                        accept="audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/x-m4a,video/mp4,.mp3,.m4a,.mp4,.wav,.ogg"
                        multiple
                        hidden
                        onChange={(event) => {
                          void importFiles(event.target.files);
                          event.target.value = '';
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="soundlab-chip-btn"
                      onClick={() => void refreshMusic()}
                    >
                      <RefreshCw size={14} /> Refresh
                    </button>
                  </div>
                </div>
                <ul className="soundlab-track-list">
                  {tracks.map((track, i) => (
                    <li key={track.id} className={i === index ? 'active' : ''}>
                      <button type="button" onClick={() => void playAt(i)}>
                        <span className="soundlab-track-index">
                          {String(i + 1).padStart(2, '0')}
                        </span>
                        <span className="soundlab-track-meta">
                          <strong>{track.title}</strong>
                          <small>
                            {track.artist} ·{' '}
                            {track.source === 'disk'
                              ? 'EnginePlaylist'
                              : track.source === 'local'
                                ? 'Local'
                                : 'Preset'}
                          </small>
                        </span>
                        {i === index && playing ? <span className="soundlab-eq-dot" /> : null}
                      </button>
                      {(track.source === 'local' || track.source === 'disk') && (
                        <button
                          type="button"
                          className="soundlab-icon-btn"
                          aria-label={`Remove ${track.title}`}
                          onClick={() => void removeLocal(track.id)}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </li>
                  ))}
                  {!tracks.length && (
                    <li className="soundlab-empty">
                      No songs yet. Import MP3/M4A/MP4/WAV to start.
                    </li>
                  )}
                </ul>
              </aside>
            </motion.section>
          ) : (
            <motion.section
              key="menu"
              className="soundlab-stage soundlab-stage-menu"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.22 }}
            >
              <aside className="soundlab-library">
                <div className="soundlab-library-head">
                  <div>
                    <h3>Menu Sounds</h3>
                    <p>
                      {gamePath
                        ? 'iisStupidMenu/Sounds'
                        : demo
                          ? 'Sample pack'
                          : 'Desktop + Gorilla Tag required'}
                    </p>
                  </div>
                  <div className="soundlab-library-actions">
                    <label className={`soundlab-chip-btn ${!gamePath ? 'is-disabled' : ''}`}>
                      <Upload size={14} /> Upload
                      <input
                        type="file"
                        accept="audio/mpeg,.mp3,video/mp4,.mp4"
                        multiple
                        hidden
                        disabled={!gamePath || menuBusy}
                        onChange={(event) => {
                          void uploadMenuSound(event.target.files);
                          event.target.value = '';
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="soundlab-chip-btn"
                      disabled={menuBusy}
                      onClick={() => void refreshMenuSounds()}
                    >
                      <RefreshCw size={14} /> Refresh
                    </button>
                  </div>
                </div>
                <ul className="soundlab-track-list soundlab-menu-list">
                  {menuSounds.map((entry) => (
                    <li
                      key={entry.filename}
                      className={selected === entry.filename ? 'active' : ''}
                    >
                      <button type="button" onClick={() => setSelected(entry.filename)}>
                        <span className={`soundlab-enable-dot ${entry.enabled ? 'on' : ''}`} />
                        <span className="soundlab-track-meta">
                          <strong>{entry.filename}</strong>
                          <small>
                            {size(entry.byte_size)} · {entry.media.toUpperCase()}
                            {!entry.enabled ? ' · off' : ''}
                          </small>
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`soundlab-icon-btn ${entry.enabled ? 'is-on' : ''}`}
                        aria-label={entry.enabled ? 'Disable sound' : 'Enable sound'}
                        disabled={menuBusy}
                        onClick={() => void toggleEnabled(entry)}
                      >
                        <Power size={14} />
                      </button>
                    </li>
                  ))}
                  {!menuSounds.length && (
                    <li className="soundlab-empty">
                      No menu sounds yet. Upload MP3/MP4 into the Sounds folder.
                    </li>
                  )}
                </ul>
                {menuStatus ? (
                  <p className="soundlab-status" role="status">
                    {menuStatus}
                  </p>
                ) : null}
              </aside>

              <div className="soundlab-fx-panel">
                {selectedEntry ? (
                  <>
                    <div className="soundlab-fx-head">
                      <div>
                        <p className="eyebrow">LIVE FX</p>
                        <h2>{selectedEntry.filename}</h2>
                        <p>Tweaks save beside the menu folder on desktop.</p>
                      </div>
                      <button
                        type="button"
                        className="soundlab-play soundlab-play-sm"
                        disabled={menuBusy}
                        onClick={() => (previewPlaying ? stopPreview() : void startPreview())}
                      >
                        {previewPlaying ? <Pause size={18} /> : <Play size={18} />}
                      </button>
                    </div>
                    <div className="soundlab-fx-grid">
                      {FX_SLIDERS.map(([key, label, min, max, step]) => (
                        <label key={key} className="soundlab-fx-slider">
                          <span>
                            {label}
                            <em>{draftFx[key].toFixed(2)}</em>
                          </span>
                          <input
                            type="range"
                            min={min}
                            max={max}
                            step={step}
                            value={draftFx[key]}
                            onChange={(event) => {
                              const nextFx = { ...draftFx, [key]: Number(event.target.value) };
                              void persistFx(nextFx);
                            }}
                          />
                        </label>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="soundlab-chip-btn"
                      onClick={() => void persistFx({ ...FX_DEFAULT })}
                    >
                      Reset FX
                    </button>
                  </>
                ) : (
                  <div className="soundlab-fx-empty">
                    <Sparkles size={28} />
                    <h2>Pick a menu sound</h2>
                    <p>Select a file on the left to shape bass, speed, distortion, and more.</p>
                  </div>
                )}
              </div>
            </motion.section>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
