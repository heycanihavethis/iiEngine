import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_LATEST_MENU_DLL,
  hasInstalledMenu,
  matchesRelease,
  selectedRelease,
  type HealthReport,
  type MenuRelease,
  type ReleaseCatalog,
} from './launcher';

const release: MenuRelease = {
  id: 'release-1',
  name: 'Stable',
  version: '1.2.3',
  published_at: '2026-09-16T00:00:00Z',
  sha256: 'a'.repeat(64),
  byte_size: 123,
  download_url: 'https://github.com/iireborn/menu/releases/download/1.2.3/ii.Reborn.dll',
  changelog: { added: [], removed: [], changed: [], fixes: [] },
  release_notes: '',
};

function report(status: string, hash = release.sha256): HealthReport {
  return {
    status,
    checks: [
      {
        name: 'Release integrity',
        status: 'Unknown',
        detail: 'Verified against the selected release by the launcher',
      },
    ],
    files: [
      {
        name: 'BepInEx/plugins/ii.Reborn.dll',
        size: 123,
        sha256: hash,
        modified_at: 0,
        menu: true,
        plugins: [{ guid: 'org.iidk.gorillatag.iimenu', name: 'ii Menu', version: '1.2.3' }],
      },
    ],
  };
}

describe('matchesRelease', () => {
  it('accepts the exact managed DLL even when unrelated health checks are warnings', () => {
    expect(matchesRelease(report('Warning'), release)).toBe(true);
  });

  it('rejects a DLL whose hash differs from the selected release', () => {
    expect(matchesRelease(report('Warning', 'b'.repeat(64)), release)).toBe(false);
  });
});

describe('hasInstalledMenu', () => {
  it('detects an on-disk ii menu even when the hash does not match the catalog', () => {
    expect(hasInstalledMenu(report('Warning', 'b'.repeat(64)))).toBe(true);
  });

  it('is false when no menu DLL is present', () => {
    const empty: HealthReport = { ...report('Fail'), files: [] };
    expect(hasInstalledMenu(empty)).toBe(false);
  });
});

describe('preferredRepairMode', () => {
  it('uses menu-only repair when Doorstop and BepInEx already match the baseline', async () => {
    const { preferredRepairMode, loaderReady } = await import('./launcher');
    const healthy: HealthReport = {
      status: 'Healthy',
      checks: [
        { name: 'winhttp.dll', status: 'Healthy', detail: 'ok' },
        { name: 'doorstop_config.ini', status: 'Healthy', detail: 'ok' },
        { name: 'BepInEx/core/BepInEx.dll', status: 'Healthy', detail: 'ok' },
      ],
      files: [],
    };
    expect(loaderReady(healthy)).toBe(true);
    expect(preferredRepairMode(healthy)).toBe('menu');
  });

  it('falls back to targeted install when the loader is missing or unhealthy', async () => {
    const { preferredRepairMode, loaderReady } = await import('./launcher');
    const missing: HealthReport = {
      status: 'Fail',
      checks: [
        { name: 'winhttp.dll', status: 'Error', detail: 'missing' },
        { name: 'doorstop_config.ini', status: 'Error', detail: 'missing' },
        { name: 'BepInEx/core/BepInEx.dll', status: 'Error', detail: 'missing' },
      ],
      files: [],
    };
    expect(loaderReady(missing)).toBe(false);
    expect(preferredRepairMode(missing)).toBe('targeted');
  });
});

describe('selectedRelease', () => {
  it('keeps the tagged menuversion download URL when it is official', () => {
    const catalog: ReleaseCatalog = { latest_id: release.id, items: [release] };
    const selected = selectedRelease(catalog, release.id);
    expect(selected?.download_url).toBe(
      'https://github.com/iireborn/menu/releases/download/1.2.3/ii.Reborn.dll',
    );
    expect(GITHUB_LATEST_MENU_DLL).toBe(
      'https://github.com/iireborn/menu/releases/latest/download/ii.Reborn.dll',
    );
  });

  it('falls back to the rolling latest URL when download_url is missing', () => {
    const catalog: ReleaseCatalog = {
      latest_id: release.id,
      items: [{ ...release, download_url: undefined }],
    };
    const selected = selectedRelease(catalog, release.id);
    expect(selected?.download_url).toBe(GITHUB_LATEST_MENU_DLL);
  });
});

describe('getMenuReleases', () => {
  it('prefers GitHub menuversion (tagged URL + sha) over the API catalog', async () => {
    const { getMenuReleases } = await import('./launcher');
    const api = await import('./api');
    vi.spyOn(api, 'apiRequest').mockResolvedValue(
      new Response(
        JSON.stringify({
          latest_id: 'stale',
          items: [
            {
              ...release,
              sha256: 'b'.repeat(64),
              download_url: GITHUB_LATEST_MENU_DLL,
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes('menustatus.json')) {
          return new Response(JSON.stringify({ menustatus: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            version: '1.1.0',
            sha256: 'e1ca1f93aa06b9306e40230903caf73d343a3c30d24152c4b191baabb1cf7fc3',
            downloadUrl: 'https://github.com/iireborn/menu/releases/download/1.1.0/ii.Reborn.dll',
            releaseUrl: 'https://github.com/iireborn/menu/releases',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    const catalog = await getMenuReleases();
    expect(catalog.items[0]?.version).toBe('1.1.0');
    expect(catalog.items[0]?.sha256).toBe(
      'e1ca1f93aa06b9306e40230903caf73d343a3c30d24152c4b191baabb1cf7fc3',
    );
    expect(catalog.items[0]?.download_url).toBe(
      'https://github.com/iireborn/menu/releases/download/1.1.0/ii.Reborn.dll',
    );
  });

  it('returns an empty catalog instead of throwing when every source fails', async () => {
    localStorage.clear();
    const { getMenuReleases } = await import('./launcher');
    const api = await import('./api');
    vi.spyOn(api, 'apiRequest').mockRejectedValue(new Error('offline'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 })),
    );
    await expect(getMenuReleases()).resolves.toEqual({ latest_id: null, items: [] });
  });
});

describe('confirm-before-apply menu update helpers', () => {
  it('checkMenuUpdateStatus reports updateAvailable without writing game files', async () => {
    const { checkMenuUpdateStatus } = await import('./launcher');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes('menustatus.json')) {
          return new Response(JSON.stringify({ menustatus: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            version: '1.1.0',
            sha256: 'e1ca1f93aa06b9306e40230903caf73d343a3c30d24152c4b191baabb1cf7fc3',
            downloadUrl: 'https://github.com/iireborn/menu/releases/download/1.1.0/ii.Reborn.dll',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    const status = await checkMenuUpdateStatus();
    expect(status.release?.version).toBe('1.1.0');
    expect(status.release?.canonical_filename).toBe('ii.Reborn.dll');
    expect(status.updateAvailable).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.missing).toBe(true);
    expect(status.gamePath).toBeNull();
  });

  it('prefetchLatestMenu reports updateAvailable and does not cache outside Tauri', async () => {
    const { prefetchLatestMenu } = await import('./launcher');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes('menustatus.json')) {
          return new Response(JSON.stringify({ menustatus: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            version: '1.1.0',
            sha256: 'e1ca1f93aa06b9306e40230903caf73d343a3c30d24152c4b191baabb1cf7fc3',
            downloadUrl: 'https://github.com/iireborn/menu/releases/download/1.1.0/ii.Reborn.dll',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    const result = await prefetchLatestMenu();
    expect(result.updateAvailable).toBe(true);
    expect(result.cached).toBe(false);
    expect(result.release?.canonical_filename).toBe('ii.Reborn.dll');
  });
});
