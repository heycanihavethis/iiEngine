import { describe, expect, it, vi } from 'vitest';
import {
  KRAKEN_CONFIRM_PHRASE,
  pathsAddedByKraken,
  planKrakenInstalls,
  runKrakenMode,
  waitForGameCycle,
  type KrakenCatalogMod,
  type InstalledModRef,
} from './kraken';

const catalog: KrakenCatalogMod[] = [
  {
    id: 't1',
    name: 'Trusted One',
    filename: 'TrustedOne.dll',
    sha256: 'a'.repeat(64),
    source: 'trusted',
  },
  {
    id: 'c1',
    name: 'Community One',
    filename: 'CommunityOne.dll',
    sha256: 'b'.repeat(64),
    source: 'community',
  },
  {
    id: 'c2',
    name: 'Duplicate Name',
    filename: 'TrustedOne.dll',
    sha256: 'c'.repeat(64),
    source: 'community',
  },
];

describe('kraken planning', () => {
  it('requires the confirmation phrase', () => {
    expect(KRAKEN_CONFIRM_PHRASE).toBe('RELEASE THE KRAKEN');
  });

  it('installs missing trusted and community mods and skips collisions', () => {
    const installed: InstalledModRef[] = [
      {
        relative_path: 'Already.dll',
        filename: 'Already.dll',
        sha256: 'd'.repeat(64),
      },
    ];
    const planned = planKrakenInstalls(installed, catalog);
    expect(planned.map((mod) => mod.id)).toEqual(['t1', 'c1']);
  });

  it('skips mods already present by hash', () => {
    const installed: InstalledModRef[] = [
      {
        relative_path: 'TrustedOne.dll',
        filename: 'TrustedOne.dll',
        sha256: 'A'.repeat(64),
      },
    ];
    const planned = planKrakenInstalls(installed, catalog);
    expect(planned.map((mod) => mod.id)).toEqual(['c1']);
  });

  it('diffs added plugin paths case-insensitively', () => {
    expect(
      pathsAddedByKraken(
        ['ii.s.Stupid.Menu.dll', 'Keep\\Me.dll'],
        ['ii.s.Stupid.Menu.dll', 'Keep/Me.dll', 'New.dll', 'Extra\\Mod.dll'],
      ),
    ).toEqual(['New.dll', 'Extra\\Mod.dll']);
  });
});

describe('kraken wait cycle', () => {
  it('waits for start then exit', async () => {
    const states = [false, false, true, true, false];
    const result = await waitForGameCycle({
      isRunning: async () => states.shift() ?? false,
      startTimeoutMs: 5_000,
      pollMs: 1,
    });
    expect(result).toBe('exited');
  });

  it('reports never-started', async () => {
    const result = await waitForGameCycle({
      isRunning: async () => false,
      startTimeoutMs: 5,
      pollMs: 1,
    });
    expect(result).toBe('never-started');
  });
});

describe('runKrakenMode', () => {
  it('installs, launches, waits, then removes only added mods', async () => {
    const installed: InstalledModRef[] = [
      {
        relative_path: 'Keep.dll',
        filename: 'Keep.dll',
        sha256: '1'.repeat(64),
      },
    ];
    const removed: string[] = [];
    const messages: string[] = [];
    let lists = 0;
    const result = await runKrakenMode(
      {
        listInstalled: async () => {
          lists += 1;
          if (lists === 1) return [...installed];
          return [
            ...installed,
            {
              relative_path: 'TrustedOne.dll',
              filename: 'TrustedOne.dll',
              sha256: 'a'.repeat(64),
            },
            {
              relative_path: 'CommunityOne.dll',
              filename: 'CommunityOne.dll',
              sha256: 'b'.repeat(64),
            },
          ];
        },
        installTrusted: async () => undefined,
        installCommunity: async () => undefined,
        removeInstalled: async (_gamePath, relativePath) => {
          removed.push(relativePath);
        },
        launchGame: async () => undefined,
        isGameRunning: vi
          .fn()
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false),
        fetchCatalog: async () => catalog,
        ensureGameReady: async () => 'C:/Games/Gorilla Tag',
      },
      (message) => messages.push(message),
      { pollMs: 1, startTimeoutMs: 5_000 },
    );

    expect(result.active).toBe(false);
    expect(removed).toEqual(['TrustedOne.dll', 'CommunityOne.dll']);
    expect(messages.some((message) => /Installing 2 mods/i.test(message))).toBe(true);
    expect(messages.some((message) => /finished/i.test(message))).toBe(true);
  });

  it('cleans up after a launch failure', async () => {
    const removed: string[] = [];
    let lists = 0;
    await expect(
      runKrakenMode(
        {
          listInstalled: async () => {
            lists += 1;
            if (lists === 1) {
              return [
                {
                  relative_path: 'Keep.dll',
                  filename: 'Keep.dll',
                  sha256: '1'.repeat(64),
                },
              ];
            }
            return [
              {
                relative_path: 'Keep.dll',
                filename: 'Keep.dll',
                sha256: '1'.repeat(64),
              },
              {
                relative_path: 'TrustedOne.dll',
                filename: 'TrustedOne.dll',
                sha256: 'a'.repeat(64),
              },
            ];
          },
          installTrusted: async () => undefined,
          installCommunity: async () => undefined,
          removeInstalled: async (_gamePath, relativePath) => {
            removed.push(relativePath);
          },
          launchGame: async () => {
            throw new Error('Steam refused');
          },
          isGameRunning: async () => false,
          fetchCatalog: async () => [catalog[0]!],
          ensureGameReady: async () => 'C:/Games/Gorilla Tag',
        },
        () => undefined,
      ),
    ).rejects.toThrow(/Steam refused/);
    expect(removed).toEqual(['TrustedOne.dll']);
  });
});
