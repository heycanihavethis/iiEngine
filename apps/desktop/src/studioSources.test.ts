import { describe, expect, it } from 'vitest';
import { isProOnlyStudioSource, studioProjectSourceOptions } from './studioSources';

describe('studioProjectSourceOptions', () => {
  it('limits Free to menu template and ii Reborn Menu', () => {
    expect(studioProjectSourceOptions(false).map((option) => option.value)).toEqual([
      'ii_template',
      'ii_stupid_menu',
    ]);
  });

  it('adds GitHub, ZIP, and blank for Pro', () => {
    expect(studioProjectSourceOptions(true).map((option) => option.value)).toEqual([
      'ii_template',
      'ii_stupid_menu',
      'open_source',
      'zip_import',
      'blank',
    ]);
  });

  it('marks import sources as Pro-only', () => {
    expect(isProOnlyStudioSource('ii_template')).toBe(false);
    expect(isProOnlyStudioSource('ii_stupid_menu')).toBe(false);
    expect(isProOnlyStudioSource('open_source')).toBe(true);
    expect(isProOnlyStudioSource('zip_import')).toBe(true);
    expect(isProOnlyStudioSource('blank')).toBe(true);
  });
});
