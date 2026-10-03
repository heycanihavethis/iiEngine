export type KrakenCatalogMod = {
  id: string;
  name: string;
  filename: string;
  sha256: string;
  source: 'trusted' | 'community';
};

export type InstalledModRef = {
  relative_path: string;
  filename: string;
  sha256: string;
};

export type KrakenSession = {
  active: boolean;
  gamePath: string;
  preservedPaths: string[];
  addedPaths: string[];
  launchedAt: number;
};

export const KRAKEN_CONFIRM_PHRASE = 'RELEASE THE KRAKEN';

export function normalizePluginPath(path: string) {
  return path.replace(/\\/g, '/').toLowerCase();
}

export function planKrakenInstalls(
  installed: InstalledModRef[],
  catalog: KrakenCatalogMod[],
): KrakenCatalogMod[] {
  const hashes = new Set(installed.map((item) => item.sha256.toLowerCase()));
  const names = new Set(installed.map((item) => item.filename.toLowerCase()));
  const planned: KrakenCatalogMod[] = [];
  const ordered = [
    ...catalog.filter((mod) => mod.source === 'trusted'),
    ...catalog.filter((mod) => mod.source === 'community'),
  ];
  for (const mod of ordered) {
    const hash = mod.sha256.toLowerCase();
    const name = mod.filename.toLowerCase();
    if (hashes.has(hash) || names.has(name)) continue;
    planned.push(mod);
    hashes.add(hash);
    names.add(name);
  }
  return planned;
}

export function pathsAddedByKraken(before: string[], after: string[]): string[] {
  const preserved = new Set(before.map(normalizePluginPath));
  return after.filter((path) => !preserved.has(normalizePluginPath(path)));
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export async function waitForGameCycle(options: {
  isRunning: () => Promise<boolean>;
  startTimeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}): Promise<'exited' | 'never-started'> {
  const startTimeoutMs = options.startTimeoutMs ?? 180_000;
  const pollMs = options.pollMs ?? 1500;
  const startedAt = Date.now();
  let sawRunning = false;

  while (Date.now() - startedAt < startTimeoutMs) {
    if (options.signal?.aborted) throw new Error('Kraken wait was cancelled.');
    if (await options.isRunning()) {
      sawRunning = true;
      break;
    }
    await sleep(pollMs);
  }

  if (!sawRunning) return 'never-started';

  while (await options.isRunning()) {
    if (options.signal?.aborted) throw new Error('Kraken wait was cancelled.');
    await sleep(pollMs);
  }
  return 'exited';
}

export type KrakenProgress = (message: string) => void;

export type KrakenDeps = {
  listInstalled: (gamePath: string) => Promise<InstalledModRef[]>;
  installTrusted: (mod: KrakenCatalogMod, gamePath: string) => Promise<void>;
  installCommunity: (mod: KrakenCatalogMod, gamePath: string) => Promise<void>;
  removeInstalled: (gamePath: string, relativePath: string) => Promise<void>;
  launchGame: (gamePath: string) => Promise<void>;
  isGameRunning: () => Promise<boolean>;
  fetchCatalog: () => Promise<KrakenCatalogMod[]>;
  ensureGameReady: (progress: KrakenProgress) => Promise<string>;
  backupPlugins?: (gamePath: string) => Promise<string>;
};

export async function cleanupKrakenMods(
  gamePath: string,
  addedPaths: string[],
  removeInstalled: KrakenDeps['removeInstalled'],
  progress?: KrakenProgress,
) {
  const unique = [...new Set(addedPaths.map((path) => path.replace(/\\/g, '/')))];
  for (const relativePath of unique) {
    progress?.(`Removing Kraken mod ${relativePath}…`);
    try {
      await removeInstalled(gamePath, relativePath);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (!/not found|already/i.test(message)) {
        progress?.(`Could not remove ${relativePath}: ${message}`);
      }
    }
  }
}

export async function runKrakenMode(
  deps: KrakenDeps,
  progress: KrakenProgress,
  options?: {
    signal?: AbortSignal;
    onSession?: (session: KrakenSession) => void;
    startTimeoutMs?: number;
    pollMs?: number;
  },
): Promise<KrakenSession> {
  progress('Preparing The Kraken…');
  const gamePath = await deps.ensureGameReady(progress);
  if (deps.backupPlugins) {
    progress('Creating a safety backup of your plugins folder…');
    try {
      const path = await deps.backupPlugins(gamePath);
      progress(`Safety backup saved${path ? ` (${path})` : ''}.`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      throw new Error(`Could not create a safety backup before The Kraken: ${message}`, {
        cause: reason,
      });
    }
  }
  const before = await deps.listInstalled(gamePath);
  const preservedPaths = before.map((item) => item.relative_path.replace(/\\/g, '/'));
  let session: KrakenSession = {
    active: true,
    gamePath,
    preservedPaths,
    addedPaths: [],
    launchedAt: Date.now(),
  };
  options?.onSession?.(session);

  try {
    progress('Pulling every trusted and community mod…');
    const catalog = await deps.fetchCatalog();
    const planned = planKrakenInstalls(before, catalog);
    progress(
      planned.length
        ? `Installing ${planned.length} mod${planned.length === 1 ? '' : 's'} into plugins…`
        : 'All catalog mods are already present. Launching with the current plugins…',
    );

    let index = 0;
    for (const mod of planned) {
      if (options?.signal?.aborted) throw new Error('Kraken launch was cancelled.');
      index += 1;
      progress(`Installing ${index}/${planned.length}: ${mod.name} (${mod.source})…`);
      if (mod.source === 'trusted') await deps.installTrusted(mod, gamePath);
      else await deps.installCommunity(mod, gamePath);
    }

    const after = await deps.listInstalled(gamePath);
    const addedPaths = pathsAddedByKraken(
      preservedPaths,
      after.map((item) => item.relative_path),
    );
    session = { ...session, addedPaths, launchedAt: Date.now() };
    options?.onSession?.(session);

    progress('Launching Gorilla Tag with The Kraken…');
    await deps.launchGame(gamePath);
    progress('Waiting for Gorilla Tag to close so plugins can be restored…');
    const outcome = await waitForGameCycle({
      isRunning: deps.isGameRunning,
      signal: options?.signal,
      startTimeoutMs: options?.startTimeoutMs,
      pollMs: options?.pollMs,
    });
    if (outcome === 'never-started') {
      progress('Gorilla Tag did not start in time. Restoring plugins…');
    } else {
      progress('Gorilla Tag closed. Restoring your previous plugins…');
    }
    await cleanupKrakenMods(gamePath, addedPaths, deps.removeInstalled, progress);
    session = { ...session, active: false, addedPaths: [] };
    options?.onSession?.(session);
    progress('The Kraken is finished. Extra mods were removed.');
    return session;
  } catch (reason) {
    const after = await deps.listInstalled(gamePath).catch(() => before);
    const addedPaths =
      session.addedPaths.length > 0
        ? session.addedPaths
        : pathsAddedByKraken(
            preservedPaths,
            after.map((item) => item.relative_path),
          );
    if (addedPaths.length) {
      progress('Cleaning up Kraken mods after failure…');
      await cleanupKrakenMods(gamePath, addedPaths, deps.removeInstalled, progress);
    }
    session = { ...session, active: false, addedPaths: [] };
    options?.onSession?.(session);
    throw reason;
  }
}
