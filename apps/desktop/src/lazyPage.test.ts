import { describe, it, expect } from 'vitest';
import { loadPageModule } from './lazyPage';

function Dummy() {
  return null;
}

describe('loadPageModule', () => {
  it('returns a module that exports a default component', async () => {
    const mod = await loadPageModule(async () => ({ default: Dummy }), 'Dummy');
    expect(mod.default).toBe(Dummy);
  });

  it('retries with bust when the first module has no default (Vite empty HMR)', async () => {
    const empty = {} as { default: typeof Dummy };
    const mod = await loadPageModule(
      async () => empty,
      'Dummy',
      async () => ({ default: Dummy }),
    );
    expect(mod.default).toBe(Dummy);
  });

  it('throws a normal Error instead of letting React stringify a Module namespace', async () => {
    await expect(
      loadPageModule(async () => ({}) as { default: typeof Dummy }, 'Mod Library'),
    ).rejects.toThrow(/Mod Library failed to load/);
  });
});
