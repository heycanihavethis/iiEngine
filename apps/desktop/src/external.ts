import { invoke, isTauri } from '@tauri-apps/api/core';
import type { MouseEvent } from 'react';

export async function openExternal(url: string) {
  if (isTauri()) {
    await invoke('open_external', { url });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function externalClick(url: string) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    void openExternal(url);
  };
}
