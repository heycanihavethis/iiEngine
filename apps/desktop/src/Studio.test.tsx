import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Studio from './Studio';

const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => native);
vi.mock('@monaco-editor/react', () => ({
  default: () => <div data-testid="monaco" />,
  loader: { config: () => undefined },
}));

const project = {
  id: 'project-1',
  name: 'My ii menu',
  created_at: '2026-01-01T00:00:00Z',
  source_repository: 'ii_stupid_menu',
};

beforeEach(() => {
  native.isTauri.mockReturnValue(true);
  native.invoke.mockImplementation(async (command: string) => {
    if (command === 'studio_environment')
      return { ready: true, dotnet: '9.0.0', git: '2.45.0', projects_root: 'C:\\ii\\projects' };
    if (command === 'studio_list_projects') return [project];
    if (command === 'discover_game') return [{ path: 'D:\\Gorilla Tag', valid: true, missing: [] }];
    if (command === 'studio_list_files')
      return [{ path: 'Mods/Example.cs', name: 'Example.cs', depth: 1, kind: 'file' }];
    if (command === 'auth_resume') return { access_token: null, expires_in: 900 };
    return null;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) }),
  );
});

afterEach(() => {
  cleanup();
  native.invoke.mockReset();
  vi.unstubAllGlobals();
});

it('offers the primary build actions in the top toolbar', async () => {
  render(<Studio demo={false} canLaunch />);

  expect(await screen.findByRole('button', { name: /^Build$/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Save$/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Install DLL/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Build & Play/ })).toBeInTheDocument();

  const toolbar = document.querySelector('.studio-toolbar-build');
  expect(toolbar).not.toBeNull();
  expect(toolbar?.querySelectorAll('button').length).toBe(4);
  expect(document.querySelectorAll('.studio-tab-toolbar button[title="Build"]').length).toBe(0);
});
