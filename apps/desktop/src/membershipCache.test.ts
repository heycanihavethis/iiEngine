import { afterEach, describe, expect, it } from 'vitest';
import type { Dashboard } from '../../../packages/contracts/dashboard';
import {
  clearMembershipCache,
  dashboardFromMembershipCache,
  mergeDashboardWithMembershipCache,
  readMembershipCacheSync,
  rememberMembership,
} from './membershipCache';

const baseDashboard: Dashboard = {
  demo: false,
  member: {
    display_name: 'Mega',
    avatar: null,
    membership: true,
    roles: [{ id: '1', name: 'Pro', color: '#fff', position: 1 }],
    entitlements: ['user', 'pro'],
  },
  release: {
    version: '1.1.0',
    channel: 'stable',
    signature: 'menuversion.json',
    published_at: null,
  },
  announcements: [],
  announcements_stale: false,
};

afterEach(() => {
  clearMembershipCache();
});

describe('membershipCache', () => {
  it('remembers a verified membership and restores it later', async () => {
    await rememberMembership(baseDashboard);
    const cached = readMembershipCacheSync();
    expect(cached?.member.entitlements).toContain('pro');
    const restored = dashboardFromMembershipCache(cached!);
    expect(restored.member.membership).toBe(true);
    expect(restored.membershipCached).toBe(true);
  });

  it('keeps local entitlements when the API says membership is false', async () => {
    await rememberMembership(baseDashboard);
    const merged = await mergeDashboardWithMembershipCache({
      ...baseDashboard,
      member: { ...baseDashboard.member, membership: false, entitlements: [], roles: [] },
    });
    expect(merged.member.membership).toBe(true);
    expect(merged.member.entitlements).toContain('pro');
    expect(merged.membershipCached).toBe(true);
  });

  it('does not invent membership when there is no local cache', async () => {
    const merged = await mergeDashboardWithMembershipCache({
      ...baseDashboard,
      member: { ...baseDashboard.member, membership: false, entitlements: [], roles: [] },
    });
    expect(merged.member.membership).toBe(false);
    expect(merged.membershipCached).toBeUndefined();
  });
});
