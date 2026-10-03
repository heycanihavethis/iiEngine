import { invoke, isTauri } from '@tauri-apps/api/core';
import { apiRequest } from './api';
import { readMenuCatalogCache, rememberMenuCatalog } from './menuCatalogCache';

export const GITHUB_LATEST_MENU_DLL =
  'https://github.com/iireborn/menu/releases/latest/download/ii.Reborn.dll';

const MENUVERSION_URLS = [
  'https://github.com/iireborn/menu/raw/refs/heads/main/menuversion.json',
  'https://raw.githubusercontent.com/iireborn/menu/refs/heads/main/menuversion.json',
  'https://raw.githubusercontent.com/iireborn/menu/main/menuversion.json',
] as const;
const MENUSTATUS_URLS = [
  'https://github.com/iireborn/menu/raw/refs/heads/main/menustatus.json',
  'https://raw.githubusercontent.com/iireborn/menu/refs/heads/main/menustatus.json',
  'https://raw.githubusercontent.com/iireborn/menu/main/menustatus.json',
] as const;

async function fetchGithubJson(urls: readonly string[]): Promise<unknown> {
  let lastError: Error | null = null;
  for (const url of urls) {
    const bust = `${url}${url.includes('?') ? '&' : '?'}_ts=${Date.now()}`;
    try {
      const response = await fetch(bust, {
        cache: 'no-store',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      return await response.json();
    } catch (reason) {
      lastError = reason instanceof Error ? reason : new Error(String(reason));
    }
  }
  throw lastError ?? new Error('Could not reach the official menu metadata');
}

export type MenuRelease = {
  id: string;
  name: string;
  version: string;
  published_at: string;
  sha256: string;
  byte_size: number;
  download_url?: string;
  release_url?: string;
  canonical_filename?: string;
  changelog: { added: string[]; removed: string[]; changed: string[]; fixes: string[] };
  release_notes: string;
};

export type ReleaseCatalog = { latest_id: string | null; items: MenuRelease[] };
export type GameCandidate = { path: string; valid: boolean; missing: string[] };
export type HealthReport = {
  status: string;
  checks: { name: string; status: string; detail: string }[];
  files: {
    name: string;
    size: number;
    sha256: string;
    modified_at: number;
    menu: boolean;
    plugins: { guid: string; name: string; version: string }[];
  }[];
};
type InstallPreview = {
  token: string;
  menu_version: string;
  backup_bytes: number;
  scopes: string[];
  changes: number;
};

type GithubMenuMetadata = {
  version: string;
  sha256: string;
  download_url: string;
  release_url: string;
  byte_size: number;
  published_at: string;
  menu_online?: boolean;
};

function officialMenuDownloadUrl(value: string | undefined | null): string | null {
  if (!value || typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
    const path = url.pathname;
    const allowed =
      path.startsWith('/iireborn/menu/releases/download/') ||
      path.startsWith('/iireborn/menu/releases/latest/download/') ||
      path.startsWith('/iireborn/ii.stupid.menu/releases/download/') ||
      path.startsWith('/iireborn/iis.Stupid.Menu/releases/download/');
    return allowed ? value : null;
  } catch {
    return null;
  }
}

function withTrustedDownload(release: MenuRelease): MenuRelease {
  const trusted =
    officialMenuDownloadUrl(release.download_url) ??
    officialMenuDownloadUrl(GITHUB_LATEST_MENU_DLL) ??
    GITHUB_LATEST_MENU_DLL;
  return { ...release, download_url: trusted };
}

function catalogFromMetadata(meta: GithubMenuMetadata): ReleaseCatalog {
  const item: MenuRelease = {
    id: 'github-latest',
    name: `ii Menu ${meta.version}`,
    version: meta.version,
    published_at: meta.published_at,
    sha256: meta.sha256.toLowerCase(),
    byte_size: meta.byte_size || 0,
    download_url:
      officialMenuDownloadUrl(meta.download_url) ??
      officialMenuDownloadUrl(GITHUB_LATEST_MENU_DLL) ??
      GITHUB_LATEST_MENU_DLL,
    release_url: meta.release_url,
    canonical_filename: 'ii.Reborn.dll',
    changelog: { added: [], removed: [], changed: [], fixes: [] },
    release_notes:
      'Pulled from https://github.com/iireborn/menu (menuversion.json + menustatus.json). ii Engine does not store this DLL.',
  };
  return { latest_id: item.id, items: [item] };
}

function hasUsableSha(catalog: ReleaseCatalog | null | undefined) {
  return Boolean(
    catalog?.items?.some((item) => typeof item.sha256 === 'string' && item.sha256.length === 64),
  );
}

async function fetchGithubMenuMetadataDirect(): Promise<ReleaseCatalog> {
  if (isTauri()) {
    const meta = await invoke<GithubMenuMetadata>('fetch_github_menu_metadata');
    return catalogFromMetadata(meta);
  }
  try {
    const statusPayload = (await fetchGithubJson(MENUSTATUS_URLS)) as {
      menustatus?: boolean;
      status?: string;
    };
    const online =
      typeof statusPayload.menustatus === 'boolean'
        ? statusPayload.menustatus
        : typeof statusPayload.status === 'string'
          ? !['false', 'offline', '0', 'no'].includes(statusPayload.status.trim().toLowerCase())
          : true;
    if (!online) throw new Error('Menu is marked offline in menustatus.json');
  } catch (reason) {
    if (reason instanceof Error && /marked offline/i.test(reason.message)) throw reason;
  }
  const payload = (await fetchGithubJson(MENUVERSION_URLS)) as {
    version?: string;
    sha256?: string;
    downloadUrl?: string;
    releaseUrl?: string;
  };
  if (!payload.version || !payload.sha256) {
    throw new Error('Official menu version list is missing version or sha256');
  }
  return catalogFromMetadata({
    version: payload.version,
    sha256: payload.sha256.replace(/^sha256:/i, '').toLowerCase(),
    download_url:
      officialMenuDownloadUrl(payload.downloadUrl) ??
      officialMenuDownloadUrl(GITHUB_LATEST_MENU_DLL) ??
      GITHUB_LATEST_MENU_DLL,
    release_url: payload.releaseUrl || 'https://github.com/iireborn/menu/releases',
    byte_size: 0,
    published_at: new Date().toISOString(),
    menu_online: true,
  });
}

export async function getMenuReleases(): Promise<ReleaseCatalog> {
  try {
    const catalog = await fetchGithubMenuMetadataDirect();
    if (hasUsableSha(catalog)) {
      rememberMenuCatalog(catalog);
      return catalog;
    }
  } catch {}
  try {
    const catalog = (await (await apiRequest('/v1/menu-releases')).json()) as ReleaseCatalog;
    const normalized = {
      ...catalog,
      items: Array.isArray(catalog.items) ? catalog.items.map(withTrustedDownload) : [],
    };
    if (hasUsableSha(normalized)) {
      rememberMenuCatalog(normalized);
      return normalized;
    }
  } catch {}
  const cached = readMenuCatalogCache();
  if (cached) return cached;
  return { latest_id: null, items: [] };
}

export function selectedRelease(catalog: ReleaseCatalog | undefined, selectedId: string | null) {
  if (!catalog || !Array.isArray(catalog.items) || !catalog.items.length) return null;
  const selected = catalog.items.find((item) => item.id === selectedId) ?? catalog.items[0] ?? null;
  return selected ? withTrustedDownload(selected) : null;
}

export async function detectGame() {
  const raw = await invoke<GameCandidate[] | GameCandidate | null>('discover_game');
  const candidates = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const game = candidates.find((candidate) => candidate.valid);
  if (!game) throw new Error('Gorilla Tag was not found in any Steam library.');
  return game.path;
}

export async function tryDetectGame(): Promise<string | null> {
  try {
    return await detectGame();
  } catch {
    return null;
  }
}

export async function scanInstallation(gamePath: string) {
  return invoke<HealthReport>('health_check', { gamePath });
}

export function matchesRelease(report: HealthReport, release: MenuRelease | null) {
  if (!release?.sha256) return false;
  const menus = report.files.filter((file) => file.menu);
  return (
    menus.length === 1 &&
    (menus[0].sha256 || '').toLowerCase() === release.sha256.toLowerCase() &&
    menus[0].plugins.some((plugin) => plugin.version === release.version)
  );
}

export function hasInstalledMenu(report: HealthReport | null | undefined) {
  return Boolean(report?.files?.some((file) => file.menu));
}

export type EnsureInstallationResult = {
  gamePath: string;
  changed: boolean;
  report: HealthReport;
  operationId: string | null;
  unverified: boolean;
  updateAvailable: boolean;
};

export type MenuUpdateStatus = {
  catalog: ReleaseCatalog;
  release: MenuRelease | null;
  gamePath: string | null;
  installedSha: string | null;
  installedVersion: string | null;
  ready: boolean;
  updateAvailable: boolean;
  missing: boolean;
};

function unverifiedLocalInstall(
  gamePath: string,
  report: HealthReport,
  progress: (message: string) => void,
  reason: 'outdated' | 'unverified' = 'unverified',
): EnsureInstallationResult {
  progress(
    reason === 'outdated'
      ? 'ii Menu update available. Launching with your current install…'
      : "Couldn't verify installation. Using the ii menu already on this PC…",
  );
  return {
    gamePath,
    changed: false,
    report,
    operationId: null,
    unverified: true,
    updateAvailable: reason === 'outdated',
  };
}

async function resolveRelease(release: MenuRelease | null): Promise<MenuRelease | null> {
  try {
    const catalog = await fetchGithubMenuMetadataDirect();
    const selected = selectedRelease(catalog, null);
    if (selected?.sha256) {
      rememberMenuCatalog(catalog);
      return selected;
    }
  } catch {}
  if (release?.sha256 && release.sha256.length === 64) return withTrustedDownload(release);
  const catalog = await getMenuReleases();
  return selectedRelease(catalog, null);
}

async function prepare(
  gamePath: string,
  release: MenuRelease | null,
  repairMode: 'targeted' | 'menu' | 'bepinex',
) {
  const resolved = await resolveRelease(release);
  if (!resolved?.sha256) {
    throw new Error('Official menu metadata is unavailable.');
  }
  return invoke<InstallPreview>('prepare_github_menu_install', {
    gamePath,
    version: resolved.version,
    sha256: resolved.sha256.toLowerCase(),
    downloadUrl: resolved.download_url || GITHUB_LATEST_MENU_DLL,
    repairMode,
  });
}

export async function repairInstallation(
  gamePath: string,
  release: MenuRelease | null,
  repairMode: 'targeted' | 'menu' | 'bepinex',
  progress: (message: string) => void,
) {
  progress('Finding the latest verified menu…');
  const preview = await prepare(gamePath, release, repairMode);
  progress(`Backing up ${preview.scopes.length} protected paths and applying repairs…`);
  const result = await invoke<{ operation_id: string; menu_version: string }>('execute_install', {
    token: preview.token,
  });
  return { ...result, preview };
}

export async function downloadMenuRelease(release: MenuRelease) {
  const resolved = await resolveRelease(release);
  if (!resolved?.sha256) {
    throw new Error('Official menu metadata is unavailable.');
  }
  return invoke<string>('download_github_menu_release', {
    version: resolved.version,
    sha256: resolved.sha256.toLowerCase(),
    downloadUrl: resolved.download_url || GITHUB_LATEST_MENU_DLL,
  });
}

export function loaderReady(report: HealthReport | null | undefined) {
  if (!report) return false;
  const needed = ['winhttp.dll', 'doorstop_config.ini', 'BepInEx/core/BepInEx.dll'];
  return needed.every((name) =>
    report.checks.some((check) => check.name === name && check.status === 'Healthy'),
  );
}

export function preferredRepairMode(report: HealthReport | null | undefined): 'targeted' | 'menu' {
  return loaderReady(report) ? 'menu' : 'targeted';
}

export async function ensureInstallation(
  release: MenuRelease | null,
  progress: (message: string) => void,
): Promise<EnsureInstallationResult> {
  progress('Finding Gorilla Tag…');
  const gamePath = await detectGame();
  progress('Checking BepInEx, the menu DLL, and required folders…');
  let before: HealthReport;
  try {
    before = await scanInstallation(gamePath);
  } catch (reason) {
    throw reason instanceof Error ? reason : new Error(String(reason));
  }

  const resolved = await resolveRelease(release);
  if (!resolved?.sha256) {
    throw new Error(
      hasInstalledMenu(before)
        ? 'Official menu metadata is unavailable. Launch can still use the ii menu already on this PC.'
        : 'Official menu metadata is unavailable and no ii menu is installed yet.',
    );
  }

  if (matchesRelease(before, resolved)) {
    return {
      gamePath,
      changed: false,
      report: before,
      operationId: null,
      unverified: false,
      updateAvailable: false,
    };
  }

  const repairMode = preferredRepairMode(before);
  progress(
    repairMode === 'menu'
      ? 'Installing ii.Reborn.dll into BepInEx/plugins…'
      : 'Installing BepInEx and ii.Reborn.dll…',
  );
  const installed = await repairInstallation(gamePath, resolved, repairMode, progress);
  progress('Verifying the repaired installation…');
  const report = await scanInstallation(gamePath);
  if (matchesRelease(report, resolved)) {
    return {
      gamePath,
      changed: true,
      report,
      operationId: installed.operation_id,
      unverified: false,
      updateAvailable: false,
    };
  }
  try {
    const fresh = selectedRelease(await fetchGithubMenuMetadataDirect(), null);
    if (fresh && matchesRelease(report, fresh)) {
      return {
        gamePath,
        changed: true,
        report,
        operationId: installed.operation_id,
        unverified: false,
        updateAvailable: false,
      };
    }
  } catch {}
  if (hasInstalledMenu(report)) {
    return {
      gamePath,
      changed: true,
      report,
      operationId: installed.operation_id,
      unverified: true,
      updateAvailable: false,
    };
  }
  throw new Error('The latest verified menu release did not pass final installation verification.');
}

export async function checkMenuUpdateStatus(): Promise<MenuUpdateStatus> {
  const catalog = await getMenuReleases();
  const release = selectedRelease(catalog, null);
  const empty: MenuUpdateStatus = {
    catalog,
    release,
    gamePath: null,
    installedSha: null,
    installedVersion: null,
    ready: false,
    updateAvailable: Boolean(release?.sha256),
    missing: true,
  };
  if (!isTauri() || !release?.sha256) return empty;
  const gamePath = await tryDetectGame();
  if (!gamePath) return empty;
  try {
    const report = await scanInstallation(gamePath);
    const menu = report.files.find((file) => file.menu) ?? null;
    const installedSha = menu?.sha256?.toLowerCase() ?? null;
    const installedVersion = menu?.plugins[0]?.version ?? null;
    const ready = matchesRelease(report, release);
    const missing = !hasInstalledMenu(report);
    return {
      catalog,
      release,
      gamePath,
      installedSha,
      installedVersion,
      ready,
      updateAvailable: !ready,
      missing,
    };
  } catch {
    return empty;
  }
}

export async function warmMenuPackageCache(release: MenuRelease | null = null): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const resolved = release ?? selectedRelease(await getMenuReleases(), null);
    if (!resolved?.sha256) return false;
    await invoke<string>('warm_github_menu_cache', {
      version: resolved.version,
      sha256: resolved.sha256.toLowerCase(),
      downloadUrl: resolved.download_url || GITHUB_LATEST_MENU_DLL,
    });
    return true;
  } catch {
    return false;
  }
}

export async function applyMenuUpdate(
  release: MenuRelease | null,
  progress: (message: string) => void,
): Promise<EnsureInstallationResult> {
  progress('Finding the latest verified menu…');
  return ensureInstallation(release, progress);
}

export async function prefetchLatestMenu(
  progress: (message: string) => void = () => {},
): Promise<MenuUpdateStatus & { cached: boolean }> {
  const status = await checkMenuUpdateStatus();
  if (!status.updateAvailable || !status.release?.sha256) {
    return { ...status, cached: false };
  }
  progress(
    status.missing
      ? `ii Menu ${status.release.version} is ready to install.`
      : `ii Menu ${status.release.version} update available.`,
  );
  return { ...status, cached: false };
}

export async function ensureInstallationForLaunch(
  release: MenuRelease | null,
  progress: (message: string) => void,
): Promise<EnsureInstallationResult> {
  progress('Finding Gorilla Tag…');
  const gamePath = await detectGame();
  progress('Checking the installed ii menu…');
  const report = await scanInstallation(gamePath);
  const resolved = await resolveRelease(release);
  if (resolved && matchesRelease(report, resolved)) {
    return {
      gamePath,
      changed: false,
      report,
      operationId: null,
      unverified: false,
      updateAvailable: false,
    };
  }
  if (hasInstalledMenu(report)) {
    return unverifiedLocalInstall(gamePath, report, progress, resolved ? 'outdated' : 'unverified');
  }
  throw new Error(
    resolved
      ? `ii Menu ${resolved.version} is not installed yet. Click Update ii Menu first.`
      : 'ii Menu is not installed yet. Click Update ii Menu when you are ready.',
  );
}
