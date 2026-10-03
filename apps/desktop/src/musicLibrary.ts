import { invoke, isTauri } from '@tauri-apps/api/core';
import { apiRequest } from './api';
import { detectGame } from './launcher';

export const LOCAL_KEY = 'ii-engine-local-tracks-v1';
export const VOLUME_KEY = 'ii-engine-music-volume';
export const DEFAULT_VOLUME = 0.14;
export const ENGINE_PLAYLIST_REL = 'iisStupidMenu/EnginePlaylist';

export type MusicTrack = {
  id: string;
  title: string;
  artist: string;
  source: 'local' | 'preset' | 'disk';
  url: string;
  filename?: string;
};

type PresetItem = {
  id: string;
  title: string;
  artist: string;
  filename: string;
  stream_url: string;
};

export function loadLocalMeta(): { id: string; title: string; artist: string; filename: string }[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as {
      id: string;
      title: string;
      artist: string;
      filename: string;
    }[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveLocalMeta(
  items: { id: string; title: string; artist: string; filename: string }[],
) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(items.slice(0, 40)));
}

export async function idbPut(id: string, blob: Blob) {
  const db = await openMusicDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('tracks', 'readwrite');
    tx.objectStore('tracks').put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function idbGet(id: string): Promise<Blob | null> {
  const db = await openMusicDb();
  const blob = await new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction('tracks', 'readonly');
    const req = tx.objectStore('tracks').get(id);
    req.onsuccess = () => resolve((req.result as Blob) || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return blob;
}

export async function idbDelete(id: string) {
  const db = await openMusicDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('tracks', 'readwrite');
    tx.objectStore('tracks').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function openMusicDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ii-engine-music', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const objectUrls: string[] = [];

export function revokeMusicObjectUrls() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.length = 0;
}

export async function rebuildLocalTracks(): Promise<MusicTrack[]> {
  revokeMusicObjectUrls();
  if (isTauri()) {
    try {
      const gamePath = await detectGame();
      const entries = await invoke<
        { id: string; title: string; artist: string; filename: string; byte_size: number }[]
      >('list_engine_playlist', { gamePath });
      const local: MusicTrack[] = [];
      for (const item of entries) {
        const bytes = await invoke<number[]>('read_engine_playlist_bytes', {
          gamePath,
          filename: item.filename,
        });
        const blob = new Blob([Uint8Array.from(bytes)], {
          type: mimeForFilename(item.filename),
        });
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        local.push({
          id: item.id,
          title: item.title,
          artist: item.artist || 'Imported',
          source: 'disk',
          url,
          filename: item.filename,
        });
      }
      return local;
    } catch {}
  }
  const meta = loadLocalMeta();
  const local: MusicTrack[] = [];
  for (const item of meta) {
    const blob = await idbGet(item.id);
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    local.push({
      id: item.id,
      title: item.title,
      artist: item.artist || 'Local',
      source: 'local',
      url,
      filename: item.filename,
    });
  }
  return local;
}

function mimeForFilename(filename: string) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.m4a') || lower.endsWith('.mp4')) return 'audio/mp4';
  return 'audio/mpeg';
}

export async function importDiskPlaylistFiles(files: FileList | null): Promise<number> {
  if (!files?.length || !isTauri()) return 0;
  const gamePath = await detectGame();
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
    if (!okType || file.size > 20 * 1024 * 1024) continue;
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    await invoke('import_engine_playlist_track', {
      gamePath,
      filename: file.name.replace(/[\\/]/g, '_'),
      bytes,
    });
    imported += 1;
  }
  return imported;
}

export async function removeDiskPlaylistTrack(id: string): Promise<boolean> {
  if (!isTauri() || !id.startsWith('disk:')) return false;
  const filename = id.slice('disk:'.length);
  const gamePath = await detectGame();
  await invoke('remove_engine_playlist_track', { gamePath, filename });
  return true;
}

export async function loadPresetTracks(demo: boolean): Promise<MusicTrack[]> {
  if (demo) return buildDemoTracks();
  try {
    const response = await apiRequest('/v1/background-tracks');
    const payload = (await response.json()) as { items?: PresetItem[] };
    const loaded: MusicTrack[] = [];
    for (const item of payload.items || []) {
      try {
        const audio = await apiRequest(item.stream_url, {
          signal: AbortSignal.timeout(60_000),
        });
        const blob = await audio.blob();
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        loaded.push({
          id: `preset:${item.id}`,
          title: item.title,
          artist: item.artist || 'ii Engine',
          source: 'preset',
          url,
          filename: item.filename,
        });
      } catch {}
    }
    return loaded;
  } catch {
    return [];
  }
}

function buildDemoTracks(): MusicTrack[] {
  const tones: { id: string; title: string; hz: number }[] = [
    { id: 'demo-soft-pulse', title: 'Soft Tone', hz: 196 },
    { id: 'demo-ember-hum', title: 'Low Hum', hz: 146.83 },
  ];
  return tones.map((tone) => {
    const url = URL.createObjectURL(makeToneWav(tone.hz, 4.5));
    objectUrls.push(url);
    return {
      id: tone.id,
      title: tone.title,
      artist: 'ii SoundLab',
      source: 'preset',
      url,
      filename: `${tone.id}.wav`,
    };
  });
}

function makeToneWav(frequency: number, seconds: number): Blob {
  const sampleRate = 22050;
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    const envelope = Math.min(1, t * 4) * Math.min(1, (seconds - t) * 4);
    const sample = Math.sin(2 * Math.PI * frequency * t) * 0.12 * envelope;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export async function loadAllTracks(demo: boolean): Promise<MusicTrack[]> {
  const local = await rebuildLocalTracks();
  const presets = await loadPresetTracks(demo);
  return [...local, ...presets];
}
