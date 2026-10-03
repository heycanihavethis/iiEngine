import { invoke, isTauri } from '@tauri-apps/api/core';

export function isAntivirusLockError(message: string | null | undefined): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return (
    text.includes('for verification') ||
    text.includes('real-time protection') ||
    text.includes('realtime protection') ||
    text.includes('antivirus is locking') ||
    text.includes('antivirus locked') ||
    (text.includes('antivirus') && (text.includes('lock') || text.includes('read')))
  );
}

export function antivirusLockTitle(message: string | null | undefined): string {
  if (!message) return 'Antivirus is locking the menu file.';
  const locked = message.match(/Antivirus is locking ([^\s]+) for verification/i)?.[1];
  if (locked && !locked.startsWith('staged') && locked.length < 64) {
    return `Antivirus locked ${locked}.`;
  }
  const named = message.match(/Cannot read ([^\s]+) for verification/i)?.[1];
  if (named && named.length < 64 && !named.includes('staged')) {
    return `Antivirus locked ${named}.`;
  }
  return 'Antivirus is locking the menu file.';
}

export async function openWindowsSecurityThreatSettings(): Promise<string> {
  if (!isTauri()) {
    throw new Error('Windows Security can only be opened from the desktop app.');
  }
  return invoke<string>('open_windows_security_threat_settings');
}
