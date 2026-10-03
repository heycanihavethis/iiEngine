import { create } from 'zustand';
import {
  DEFAULT_VOLUME,
  VOLUME_KEY,
  idbDelete,
  idbPut,
  importDiskPlaylistFiles,
  loadAllTracks,
  loadLocalMeta,
  removeDiskPlaylistTrack,
  saveLocalMeta,
  type MusicTrack,
} from './musicLibrary';
import { isTauri } from '@tauri-apps/api/core';
import { trackFeature } from './telemetry';

let audio: HTMLAudioElement | null = null;

function getAudio() {
  if (typeof document === 'undefined') return null;
  if (!audio) {
    audio = document.createElement('audio');
    audio.preload = 'auto';
    audio.addEventListener('ended', () => {
      useMusicStore.getState().next();
    });
    audio.addEventListener('pause', () => {
      if (audio?.ended) return;
      useMusicStore.setState({ playing: false });
    });
    audio.addEventListener('play', () => useMusicStore.setState({ playing: true }));
    audio.addEventListener('error', () => {
      useMusicStore.setState({
        playing: false,
        status: 'Could not decode that track. Try importing the MP3 again.',
      });
    });
  }
  return audio;
}

type MusicStore = {
  demo: boolean;
  ready: boolean;
  tracks: MusicTrack[];
  index: number;
  playing: boolean;
  muted: boolean;
  volume: number;
  status: string;
  setDemo: (demo: boolean) => void;
  refresh: () => Promise<void>;
  setVolume: (value: number) => void;
  setMuted: (value: boolean) => void;
  playAt: (nextIndex: number) => Promise<void>;
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  importFiles: (files: FileList | null) => Promise<void>;
  removeLocal: (id: string) => Promise<void>;
};

export const useMusicStore = create<MusicStore>((set, get) => ({
  demo: false,
  ready: false,
  tracks: [],
  index: 0,
  playing: false,
  muted: false,
  volume: (() => {
    const raw = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(raw) ? Math.min(0.45, Math.max(0.04, raw)) : DEFAULT_VOLUME;
  })(),
  status: '',
  setDemo: (demo) => {
    set({ demo });
    void get().refresh();
  },
  refresh: async () => {
    const wasPlaying = get().playing;
    const previousId = get().tracks[get().index]?.id;
    const tracks = await loadAllTracks(get().demo);
    const found = previousId ? tracks.findIndex((track) => track.id === previousId) : -1;
    const index = found >= 0 ? found : Math.min(get().index, Math.max(0, tracks.length - 1));
    set({ tracks, ready: true, index, status: tracks.length ? get().status : '' });
    const el = getAudio();
    if (el) {
      el.removeAttribute('data-track-id');
      el.removeAttribute('src');
      el.load();
    }
    if (wasPlaying && tracks.length) {
      await get().playAt(index);
    }
  },
  setVolume: (value) => {
    const volume = Math.min(0.45, Math.max(0.04, value));
    localStorage.setItem(VOLUME_KEY, String(volume));
    const el = getAudio();
    if (el) el.volume = get().muted ? 0 : volume;
    set({ volume });
  },
  setMuted: (muted) => {
    const el = getAudio();
    if (el) el.volume = muted ? 0 : get().volume;
    set({ muted });
  },
  playAt: async (nextIndex) => {
    const { tracks, muted, volume } = get();
    const el = getAudio();
    if (!el) {
      set({ status: 'Audio playback is not available in this window.' });
      return;
    }
    if (!tracks.length) {
      set({
        playing: false,
        status: 'Import an MP3 (or refresh presets) before pressing Play.',
      });
      return;
    }
    const safe = ((nextIndex % tracks.length) + tracks.length) % tracks.length;
    const track = tracks[safe];
    if (!track?.url) {
      set({ playing: false, status: 'That track has no audio URL.' });
      return;
    }
    set({ index: safe, status: '' });
    el.pause();
    el.src = track.url;
    el.setAttribute('data-track-id', track.id);
    el.volume = muted ? 0 : volume;
    try {
      await el.play();
      set({ playing: true, status: '' });
      trackFeature('music', `play:${track.source}`);
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Playback was blocked until you click Play again.'
          : 'Could not start playback. Try importing the MP3 again.';
      set({ playing: false, status: message });
    }
  },
  togglePlay: () => {
    const { playing, index, playAt, tracks } = get();
    const el = getAudio();
    if (!tracks.length) {
      set({
        status: 'Import an MP3 (or refresh presets) before pressing Play.',
      });
      return;
    }
    if (playing) {
      el?.pause();
      set({ playing: false });
      return;
    }
    void playAt(index);
  },
  next: () => {
    void get().playAt(get().index + 1);
  },
  prev: () => {
    void get().playAt(get().index - 1);
  },
  importFiles: async (files) => {
    if (!files?.length) return;
    try {
      if (isTauri()) {
        const imported = await importDiskPlaylistFiles(files);
        set({
          status: imported
            ? `Imported ${imported} track(s) into EnginePlaylist.`
            : 'No supported audio files were imported.',
        });
        trackFeature('music', 'import_disk');
        await get().refresh();
        if (imported) {
          const tracks = get().tracks;
          const firstDisk = tracks.findIndex((track) => track.source === 'disk');
          if (firstDisk >= 0) await get().playAt(firstDisk);
        }
        return;
      }
      const meta = loadLocalMeta();
      let imported = 0;
      for (const file of Array.from(files)) {
        const lower = file.name.toLowerCase();
        const okType =
          lower.endsWith('.mp3') ||
          lower.endsWith('.m4a') ||
          lower.endsWith('.mp4') ||
          lower.endsWith('.wav') ||
          lower.endsWith('.ogg') ||
          file.type.startsWith('audio/') ||
          file.type === 'video/mp4';
        if (!okType) {
          set({ status: `${file.name}: use MP3, M4A, MP4, WAV, or OGG.` });
          continue;
        }
        if (file.size > 20 * 1024 * 1024) {
          set({ status: `${file.name} is over 20 MB.` });
          continue;
        }
        const id = `local-${crypto.randomUUID()}`;
        await idbPut(id, file);
        meta.push({
          id,
          title: file.name.replace(/\.(mp3|m4a|mp4|wav|ogg)$/i, ''),
          artist: 'Imported',
          filename: file.name,
        });
        imported += 1;
      }
      saveLocalMeta(meta);
      set({ status: imported ? `Imported ${imported} track(s).` : get().status });
      trackFeature('music', 'import_local');
      await get().refresh();
      if (imported) {
        const tracks = get().tracks;
        const firstLocal = tracks.findIndex((track) => track.source === 'local');
        if (firstLocal >= 0) await get().playAt(firstLocal);
      }
    } catch (error) {
      set({
        status:
          error instanceof Error
            ? `Import failed: ${error.message}`
            : 'Import failed. Browser storage may be full. Try a smaller file.',
      });
    }
  },
  removeLocal: async (id) => {
    if (await removeDiskPlaylistTrack(id).catch(() => false)) {
      const current = get().tracks[get().index];
      if (current?.id === id) {
        getAudio()?.pause();
        set({ playing: false });
      }
      await get().refresh();
      return;
    }
    const meta = loadLocalMeta().filter((item) => item.id !== id);
    saveLocalMeta(meta);
    await idbDelete(id);
    const current = get().tracks[get().index];
    if (current?.id === id) {
      getAudio()?.pause();
      set({ playing: false });
    }
    await get().refresh();
  },
}));

export function bindMusicMediaSession() {
  if (!('mediaSession' in navigator)) return () => undefined;
  const sync = () => {
    const { tracks, index, playAt, prev, next } = useMusicStore.getState();
    const track = tracks[index];
    if (!track) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist || 'ii Engine',
      album: 'ii Engine background',
    });
    navigator.mediaSession.setActionHandler('play', () => void playAt(index));
    navigator.mediaSession.setActionHandler('pause', () => {
      getAudio()?.pause();
      useMusicStore.setState({ playing: false });
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => prev());
    navigator.mediaSession.setActionHandler('nexttrack', () => next());
  };
  sync();
  return useMusicStore.subscribe(sync);
}
