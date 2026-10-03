import { describe, expect, it } from 'vitest';
import { antivirusLockTitle, isAntivirusLockError } from './antivirusHelp';

describe('isAntivirusLockError', () => {
  it('detects verification lock messages from the installer', () => {
    expect(
      isAntivirusLockError('Antivirus is locking BepInEx/plugins/ii.Reborn.dll for verification.'),
    ).toBe(true);
    expect(isAntivirusLockError('Antivirus is locking staged winhttp.dll for verification.')).toBe(
      true,
    );
    expect(isAntivirusLockError('Cannot read file for verification')).toBe(true);
  });

  it('ignores unrelated install errors', () => {
    expect(isAntivirusLockError('Close Gorilla Tag before preparing an installation')).toBe(false);
    expect(isAntivirusLockError('Official menu metadata is unavailable.')).toBe(false);
    expect(isAntivirusLockError('')).toBe(false);
    expect(isAntivirusLockError(null)).toBe(false);
  });
});

describe('antivirusLockTitle', () => {
  it('keeps the on-screen title short', () => {
    expect(
      antivirusLockTitle('Antivirus is locking BepInEx/plugins/ii.Reborn.dll for verification.'),
    ).toBe('Antivirus locked BepInEx/plugins/ii.Reborn.dll.');
    expect(antivirusLockTitle('Cannot read BepInEx/plugins/ii.Reborn.dll for verification')).toBe(
      'Antivirus locked BepInEx/plugins/ii.Reborn.dll.',
    );
    expect(antivirusLockTitle('Antivirus is locking staged winhttp.dll for verification.')).toBe(
      'Antivirus is locking the menu file.',
    );
    expect(antivirusLockTitle(null)).toBe('Antivirus is locking the menu file.');
  });
});
