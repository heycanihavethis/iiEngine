import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Dashboard, Member } from '../../../packages/contracts/dashboard';

const STORAGE_KEY = 'ii-engine-local-membership-v1';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type LocalMembershipSnapshot = {
  savedAt: number;
  member: Member;
  release: Dashboard['release'];
};

function canUseStorage() {
  return typeof localStorage !== 'undefined';
}

function parseSnapshot(raw: string | null | undefined): LocalMembershipSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LocalMembershipSnapshot;
    if (
      !parsed ||
      typeof parsed.savedAt !== 'number' ||
      Date.now() - parsed.savedAt > MAX_AGE_MS ||
      !parsed.member?.membership ||
      !Array.isArray(parsed.member.entitlements)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function rememberMembership(dashboard: Dashboard | null | undefined) {
  if (!dashboard || dashboard.demo || !dashboard.member?.membership) return;
  const snapshot: LocalMembershipSnapshot = {
    savedAt: Date.now(),
    member: dashboard.member,
    release: dashboard.release,
  };
  const encoded = JSON.stringify(snapshot);
  if (canUseStorage()) {
    try {
      localStorage.setItem(STORAGE_KEY, encoded);
    } catch {}
  }
  if (isTauri()) {
    try {
      await invoke('membership_snapshot_save', { snapshotJson: encoded });
    } catch {}
  }
}

export async function readMembershipCache(): Promise<LocalMembershipSnapshot | null> {
  if (isTauri()) {
    try {
      const raw = await invoke<string | null>('membership_snapshot_load');
      const fromVault = parseSnapshot(raw ?? undefined);
      if (fromVault) return fromVault;
    } catch {}
  }
  if (!canUseStorage()) return null;
  try {
    return parseSnapshot(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function readMembershipCacheSync(): LocalMembershipSnapshot | null {
  if (!canUseStorage()) return null;
  try {
    return parseSnapshot(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function clearMembershipCache() {
  if (canUseStorage()) {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }
}

export function dashboardFromMembershipCache(
  cache: LocalMembershipSnapshot,
  overrides?: Partial<Member>,
): Dashboard & { membershipCached: true } {
  return {
    demo: false,
    member: {
      ...cache.member,
      ...overrides,
      membership: true,
    },
    release: cache.release ?? {
      version: 'Unavailable',
      channel: 'stable',
      signature: 'Unavailable',
      published_at: null,
    },
    announcements: [],
    announcements_stale: true,
    membershipCached: true,
  };
}

export async function mergeDashboardWithMembershipCache(
  dashboard: Dashboard,
): Promise<Dashboard & { membershipCached?: boolean }> {
  if (dashboard.demo || dashboard.member.membership) {
    await rememberMembership(dashboard);
    return dashboard;
  }
  const cache = await readMembershipCache();
  if (!cache) return dashboard;
  return {
    ...dashboard,
    member: {
      ...cache.member,
      display_name: dashboard.member.display_name || cache.member.display_name,
      avatar: dashboard.member.avatar ?? cache.member.avatar,
      membership: true,
    },
    membershipCached: true,
  };
}
