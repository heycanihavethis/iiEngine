import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_PRESET_VERSION,
  exportAppearancePreset,
  importAppearancePreset,
  normalizeAppearance,
} from './appearance';
import { askStudioAssist, localStudioAssist } from './studioAssist';
import { conePetSayings } from './conePetSayings';

describe('appearance presets', () => {
  it('round-trips layout and cone pet look', () => {
    const appearance = normalizeAppearance({
      appLayout: 'wide',
      conePetLook: 'ember',
      homeBackgroundId: 'caves',
      gridPageReveal: true,
      gridPageRevealSpeed: 'fast',
      pageAmbient: 'peg',
      homeWidgets: [
        {
          id: 'quickActions',
          visible: true,
          zone: 'below',
          size: 'compact',
        },
      ],
    });
    const preset = exportAppearancePreset(appearance);
    expect(preset.version).toBe(APPEARANCE_PRESET_VERSION);
    const imported = importAppearancePreset(preset);
    expect(imported.appLayout).toBe('wide');
    expect(imported.conePetLook).toBe('ember');
    expect(imported.homeBackgroundId).toBe('caves');
    expect(imported.gridPageReveal).toBe(true);
    expect(imported.gridPageRevealSpeed).toBe('fast');
    expect(imported.pageAmbient).toBe('peg');
    expect(imported.homeWidgets.find((w) => w.id === 'quickActions')).toMatchObject({
      zone: 'below',
      size: 'compact',
      visible: true,
    });
  });

  it('defaults page ambient and grid reveal off', () => {
    const appearance = normalizeAppearance({});
    expect(appearance.pageAmbient).toBe('none');
    expect(appearance.gridPageReveal).toBe(false);
    expect(appearance.gridPageRevealSpeed).toBe('normal');
  });

  it('migrates legacy widgets without zone/size', () => {
    const appearance = normalizeAppearance({
      homeWidgets: [{ id: 'account', visible: true } as never],
    });
    const account = appearance.homeWidgets.find((w) => w.id === 'account');
    expect(account?.zone).toBe('rail');
    expect(account?.size).toBe('regular');
  });

  it('migrates a legacy Kraken theme id to default', () => {
    expect(normalizeAppearance({ themeId: 'kraken' as never }).themeId).toBe('default');
  });

  it('defaults launch hero size and accepts compact', () => {
    expect(normalizeAppearance({}).launchHeroSize).toBe('regular');
    expect(normalizeAppearance({ launchHeroSize: 'compact' }).launchHeroSize).toBe('compact');
    expect(normalizeAppearance({ launchHeroSize: 'huge' as never }).launchHeroSize).toBe('regular');
  });

  it('defaults tracker home pills off with lastPlayer mode', () => {
    const appearance = normalizeAppearance({});
    const tracker = appearance.homeWidgets.find((widget) => widget.id === 'tracker');
    expect(tracker).toMatchObject({ visible: false, zone: 'rail', size: 'compact' });
    expect(appearance.homeTrackerMode).toBe('lastPlayer');
    expect(normalizeAppearance({ homeTrackerMode: 'targets' }).homeTrackerMode).toBe('targets');
  });
});

describe('studio assist', () => {
  it('answers locally without an API', async () => {
    const local = localStudioAssist('How do I Harmony patch a method?');
    expect(local.toLowerCase()).toContain('prefix');
    const result = await askStudioAssist('build failed', { demo: true });
    expect(result.source).toBe('local');
    expect(result.text.length).toBeGreaterThan(20);
  });
});

describe('cone pet sayings', () => {
  it('has hundreds of lines', () => {
    expect(conePetSayings.length).toBeGreaterThanOrEqual(200);
  });
});
