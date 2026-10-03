import { invoke, isTauri } from '@tauri-apps/api/core';
import { apiRequest } from './api';
import { detectGame } from './launcher';

export type MenuBridgePayload = {
  schema_version: number;
  api_base: string;
  ticket: string;
  pro: boolean;
  features: string[];
  issued_at: string;
  expires_at: string;
};

export async function syncMenuBridge(gamePath?: string) {
  if (!isTauri()) return null;
  const path = gamePath || (await detectGame());
  const response = await apiRequest('/v1/menu/bridge/ticket', { method: 'POST' });
  const body = (await response.json()) as MenuBridgePayload;
  await invoke<string>('write_menu_bridge', {
    gamePath: path,
    payload: {
      schema_version: body.schema_version,
      api_base: body.api_base,
      ticket: body.ticket,
      pro: body.pro,
      features: body.features,
      issued_at: body.issued_at,
      expires_at: body.expires_at,
    },
  });
  return body;
}

export async function clearMenuBridge(gamePath?: string) {
  if (!isTauri()) return;
  try {
    const path = gamePath || (await detectGame());
    await invoke('clear_menu_bridge', { gamePath: path });
  } catch {}
}
