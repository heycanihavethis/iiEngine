import type { Page } from './store';

const loaders: Partial<Record<Page, () => Promise<unknown>>> = {
  Customize: () => import('./Customize'),
  Tracker: () => import('./Tracker'),
  'ii SoundLab': () => import('./SoundLab'),
  'ii Studio': () => import('./Studio'),
  Autoloader: () => import('./AutoLoader'),
  Catalog: () => import('./Catalog'),
  Community: () => import('./Community'),
  Plans: () => import('./Plans'),
  Staff: () => import('./Developer'),
};

const warmed = new Set<Page>();

export function preloadPageChunk(page: Page) {
  if (warmed.has(page)) return;
  const load = loaders[page];
  if (!load) return;
  warmed.add(page);
  void load().catch(() => {
    warmed.delete(page);
  });
}
