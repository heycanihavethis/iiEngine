import { afterEach, expect, it } from 'vitest';
import {
  catalogProjectName,
  queueCatalogSourceIntent,
  takeCatalogSourceIntent,
} from './catalogStudioBridge';

afterEach(() => {
  sessionStorage.clear();
});

it('queues and consumes a catalog source intent once', () => {
  queueCatalogSourceIntent('Iron Man', 'Movement Mods');
  const first = takeCatalogSourceIntent();
  expect(first).toMatchObject({ modName: 'Iron Man', category: 'Movement Mods' });
  expect(takeCatalogSourceIntent()).toBeNull();
});

it('builds a short catalog project name', () => {
  expect(catalogProjectName('Iron Man')).toMatch(/^catalog-iron-man-[a-z0-9]+$/);
});
