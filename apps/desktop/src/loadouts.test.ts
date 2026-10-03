import { afterEach, expect, it } from 'vitest';
import {
  createLoadout,
  deleteLoadout,
  readLoadouts,
  renameLoadout,
  toggleLoadoutMod,
  writeLoadouts,
} from './loadouts';

afterEach(() => {
  writeLoadouts([]);
  localStorage.clear();
});

it('creates, renames, toggles, and deletes loadouts', () => {
  const created = createLoadout('Chaos');
  expect(readLoadouts()[0]?.name).toBe('Chaos');
  renameLoadout(created.id, 'Casual');
  expect(readLoadouts()[0]?.name).toBe('Casual');
  toggleLoadoutMod(created.id, {
    source: 'trusted',
    id: 'mod-1',
    name: 'Platforms',
    filename: 'Platforms.dll',
  });
  expect(readLoadouts()[0]?.mods).toHaveLength(1);
  toggleLoadoutMod(created.id, {
    source: 'trusted',
    id: 'mod-1',
    name: 'Platforms',
    filename: 'Platforms.dll',
  });
  expect(readLoadouts()[0]?.mods).toHaveLength(0);
  deleteLoadout(created.id);
  expect(readLoadouts()).toHaveLength(0);
});
