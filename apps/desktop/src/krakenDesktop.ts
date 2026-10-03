import { invoke } from '@tauri-apps/api/core';
import { apiRequest } from './api';
import { ensureInstallationForLaunch, type MenuRelease } from './launcher';
import {
  cleanupKrakenMods,
  type InstalledModRef,
  type KrakenCatalogMod,
  type KrakenDeps,
  type KrakenProgress,
} from './kraken';

type CatalogItem = {
  id: string;
  name: string;
  filename: string;
  sha256: string;
};

export async function fetchKrakenCatalog(): Promise<KrakenCatalogMod[]> {
  const [trustedResponse, communityResponse] = await Promise.all([
    apiRequest('/v1/trusted-mods'),
    apiRequest('/v1/community/mods').catch(() => null),
  ]);
  const trustedPayload = (await trustedResponse.json()) as { items?: CatalogItem[] };
  const trusted = (Array.isArray(trustedPayload.items) ? trustedPayload.items : []).map(
    (item): KrakenCatalogMod => ({
      id: item.id,
      name: item.name,
      filename: item.filename,
      sha256: item.sha256,
      source: 'trusted',
    }),
  );
  let community: KrakenCatalogMod[] = [];
  if (communityResponse) {
    const communityPayload = (await communityResponse.json()) as { items?: CatalogItem[] };
    community = (Array.isArray(communityPayload.items) ? communityPayload.items : []).map(
      (item): KrakenCatalogMod => ({
        id: item.id,
        name: item.name,
        filename: item.filename,
        sha256: item.sha256,
        source: 'community',
      }),
    );
  }
  return [...trusted, ...community];
}

export function createDesktopKrakenDeps(release: MenuRelease | null | undefined): KrakenDeps {
  return {
    listInstalled: async (gamePath) => {
      const items = await invoke<InstalledModRef[]>('list_installed_mods', { gamePath });
      return items;
    },
    installTrusted: async (mod, gamePath) => {
      const response = await apiRequest(`/v1/trusted-mods/${encodeURIComponent(mod.id)}/ticket`, {
        method: 'POST',
      });
      const ticket = (await response.json()) as { download_url: string };
      await invoke('install_trusted_mod', {
        gamePath,
        filename: mod.filename,
        sha256: mod.sha256,
        downloadUrl: ticket.download_url,
      });
    },
    installCommunity: async (mod, gamePath) => {
      const response = await apiRequest(
        `/v1/community/mods/${encodeURIComponent(mod.id)}/download`,
        {
          signal: AbortSignal.timeout(120_000),
        },
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      await invoke('import_local_mod', {
        gamePath,
        filename: mod.filename,
        bytes,
      });
    },
    removeInstalled: async (gamePath, relativePath) => {
      await invoke('remove_installed_mod', { gamePath, relativePath });
    },
    launchGame: async (gamePath) => {
      await invoke('launch_game', { gamePath });
    },
    isGameRunning: async () => invoke<boolean>('is_game_running'),
    fetchCatalog: fetchKrakenCatalog,
    ensureGameReady: async (progress: KrakenProgress) => {
      const result = await ensureInstallationForLaunch(release ?? null, progress);
      return result.gamePath;
    },
    backupPlugins: async (gamePath) => invoke<string>('backup_plugins_snapshot', { gamePath }),
  };
}

export async function recoverKrakenSession(
  session: { gamePath: string; addedPaths: string[] },
  progress?: KrakenProgress,
) {
  const running = await invoke<boolean>('is_game_running');
  if (running) return false;
  await cleanupKrakenMods(
    session.gamePath,
    session.addedPaths,
    async (gamePath, relativePath) => {
      await invoke('remove_installed_mod', { gamePath, relativePath });
    },
    progress,
  );
  return true;
}
