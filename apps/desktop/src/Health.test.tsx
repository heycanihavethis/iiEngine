import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Health from './Health';

const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }));
vi.mock('@tauri-apps/api/core', () => native);

function mount(demo: boolean) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Health demo={demo} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        latest_id: 'github-latest',
        items: [
          {
            id: 'github-latest',
            name: 'ii Menu 1.0.5',
            version: '1.0.5',
            published_at: '2026-09-26T06:40:23Z',
            sha256: 'a'.repeat(64),
            byte_size: 3256832,
            download_url: 'https://github.com/iireborn/menu/releases/latest/download/ii.Reborn.dll',
            changelog: { added: [], removed: [], changed: [], fixes: [] },
            release_notes: '',
          },
        ],
      }),
    }),
  );
});
afterEach(() => {
  cleanup();
  native.invoke.mockReset();
  native.isTauri.mockReturnValue(false);
  vi.unstubAllGlobals();
});

it('never invokes filesystem commands in demo mode', async () => {
  mount(true);
  expect(
    await screen.findByText('Open the Windows desktop app to inspect and repair local game files.'),
  ).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Scan again' }));
  expect(native.invoke).not.toHaveBeenCalled();
});

it('reports only the versions the scan actually found', async () => {
  native.isTauri.mockReturnValue(true);
  const gamePath = 'D:\\Fixture\\Gorilla Tag';
  const report = {
    status: 'Warning',
    checks: [
      { name: 'Game installation', status: 'Healthy', detail: 'Required game files present' },
      {
        name: 'Loader version',
        status: 'Healthy',
        detail: 'BepInEx 5.4.23.5 (5.x LTS; backup baseline 5.4.23.5)',
      },
    ],
    files: [
      {
        name: 'ii.s.Stupid.Menu.dll',
        size: 2048,
        sha256: 'abc123',
        modified_at: 0,
        menu: true,
        plugins: [{ guid: 'ii.stupid.menu', name: 'ii', version: '1.0.4' }],
      },
    ],
  };
  native.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'auth_resume') return { access_token: null, expires_in: 900 };
    if (cmd === 'discover_game')
      return [{ path: gamePath, valid: true, missing: [], manifest_present: true }];
    if (cmd === 'health_check') return report;
    if (cmd === 'check_engine_update') {
      return {
        current_version: '0.2.2',
        latest_version: '0.2.2',
        outdated: false,
        download_url: null,
        release_url: 'https://github.com/iireborn/iiEngine/releases',
        can_install: false,
        detail: 'ii Engine 0.2.2 matches the newest published release (0.2.2).',
      };
    }
    if (cmd === 'list_game_directory') return [];
    throw new Error(`unexpected invoke: ${cmd}`);
  });
  const { container } = mount(false);
  expect(await screen.findByText('Required game files present')).toBeVisible();
  const text = container.textContent ?? '';
  expect(text).toMatch(/BepInEx 5\.4\.23\.5/);
  expect(text).toMatch(/ii menu 1\.0\.4/);
  expect(text).not.toMatch(/Gorilla Tag v/);
  expect(text).not.toMatch(/v1\.0\.3/);
  expect(text).not.toMatch(/Enumerating plugin assemblies|Comparing release checksums/);
  expect(text).not.toMatch(/Scanned just now|Scanned recently/);
});

it('auto-detects the game and renders native failures honestly', async () => {
  native.isTauri.mockReturnValue(true);
  const gamePath = 'D:\\Fixture\\Gorilla Tag';
  const healthyReport = {
    status: 'Healthy',
    checks: [{ name: 'Game directory', status: 'Healthy', detail: 'Detected through Steam.' }],
    files: [],
  };
  native.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'auth_resume') return { access_token: null, expires_in: 900 };
    if (cmd === 'discover_game')
      return [{ path: gamePath, valid: true, missing: [], manifest_present: true }];
    if (cmd === 'health_check') return healthyReport;
    if (cmd === 'check_engine_update') {
      return {
        current_version: '0.2.2',
        latest_version: null,
        outdated: false,
        download_url: null,
        release_url: 'https://github.com/iireborn/iiEngine/releases',
        can_install: false,
        detail: 'ii Engine 0.2.2. No published installer version was found on GitHub Releases yet.',
      };
    }
    if (cmd === 'list_game_directory') return [];
    throw new Error(`unexpected invoke: ${cmd}`);
  });
  mount(false);
  expect(await screen.findByText('Detected through Steam.')).toBeVisible();
  expect(native.invoke).toHaveBeenCalledWith('health_check', { gamePath });

  native.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'auth_resume') return { access_token: null, expires_in: 900 };
    if (cmd === 'discover_game')
      return [{ path: gamePath, valid: true, missing: [], manifest_present: true }];
    if (cmd === 'list_game_directory') return [];
    if (cmd === 'check_engine_update') {
      return {
        current_version: '0.2.2',
        latest_version: null,
        outdated: false,
        download_url: null,
        release_url: 'https://github.com/iireborn/iiEngine/releases',
        can_install: false,
        detail: 'ii Engine 0.2.2. No published installer version was found on GitHub Releases yet.',
      };
    }
    if (cmd === 'health_check') throw 'Unsafe loader path';
    throw new Error(`unexpected invoke: ${cmd}`);
  });
  await userEvent.click(screen.getByRole('button', { name: 'Scan again' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Unsafe loader path');
  await waitFor(() => expect(native.invoke).toHaveBeenLastCalledWith('health_check', { gamePath }));
});
