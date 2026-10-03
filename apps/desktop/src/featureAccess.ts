export type FeatureKey =
  | 'app_access'
  | 'developer_panel'
  | 'studio'
  | 'mod_library'
  | 'community_mods'
  | 'community_chat'
  | 'community_posts'
  | 'launch_game'
  | 'health_repair'
  | 'announcements'
  | 'backups'
  | 'creator_application'
  | 'plans_tab'
  | 'tracker'
  | 'target_tracker'
  | 'tracker_scout'
  | 'self_tracker'
  | 'soundlab'
  | 'customize'
  | 'catalog'
  | 'home_ai';

export type FeatureRule = {
  enabled: boolean;
  everyone: boolean;
  role_ids: string[];
  entitlements: string[];
};

export type FeatureAccess = Record<FeatureKey, FeatureRule>;

const open: FeatureRule = { enabled: true, everyone: true, role_ids: [], entitlements: [] };

export const II_TRACKER_ROLE_ID = '1549151900073459752';
export const II_TRACKER_BETA_ROLE_ID = '1554650259152576513';
export const UNCAPPED_ROLE_ID = '1555606816291954819';

const trackerDefault: FeatureRule = {
  enabled: true,
  everyone: false,
  role_ids: [II_TRACKER_ROLE_ID, II_TRACKER_BETA_ROLE_ID],
  entitlements: ['ii_tracker', 'ii_tracker_beta', 'developer', 'admin', 'owner'],
};

const proDefault: FeatureRule = {
  enabled: true,
  everyone: false,
  role_ids: [],
  entitlements: ['pro', 'admin', 'owner'],
};

export const defaultFeatureAccess: FeatureAccess = {
  app_access: { ...open },
  developer_panel: {
    enabled: true,
    everyone: false,
    role_ids: [],
    entitlements: ['developer', 'admin', 'owner'],
  },
  studio: {
    enabled: true,
    everyone: false,
    role_ids: ['1549421049287020568'],
    entitlements: ['beta', 'admin', 'owner'],
  },
  mod_library: { ...open },
  community_mods: { ...open },
  community_chat: { ...open },
  community_posts: { ...open },
  launch_game: { ...open },
  health_repair: { ...open },
  announcements: { ...open },
  backups: { ...open },
  creator_application: { ...open },
  plans_tab: { ...open },
  tracker: { ...trackerDefault },
  target_tracker: { ...trackerDefault },
  tracker_scout: { ...trackerDefault },
  self_tracker: { ...open },
  soundlab: { ...proDefault },
  customize: { ...proDefault },
  catalog: { ...open },
  home_ai: { ...proDefault },
};

export function featureAllowed(
  rule: FeatureRule | undefined,
  roleIds: string[],
  entitlements: string[],
) {
  if (!rule) return true;
  if (!rule.enabled) return false;
  if (rule.everyone) return true;
  return (
    rule.role_ids.some((id) => roleIds.includes(id)) ||
    rule.entitlements.some((name) => entitlements.includes(name))
  );
}

export function hasProAccess(entitlements: string[]) {
  return entitlements.includes('pro');
}

export const ENGINE_PRO_ROLE_ID = '1551472794238320680';
export const TRUSTED_CREATOR_ROLE_ID = '1538315600768540793';
export const COMMUNITY_MOD_ACCESS_ROLE_ID = '1551029796190953562';
export const ENGINE_BETA_ROLE_ID = '1549421049287020568';
export const ENGINE_ADMIN_ROLE_ID = '1551668789668618343';
export const CONE_KILLER_ROLE_ID = '1550271602720247959';

export type MemberBadge = 'admin' | 'developer' | 'community dev' | 'beta' | 'pro' | 'free';

export function resolveMemberBadge(roleIds: string[], entitlements: string[]): MemberBadge {
  const roles = new Set(roleIds);
  const ents = new Set(entitlements);
  if (ents.has('admin') || ents.has('owner')) return 'admin';
  if (ents.has('developer')) return 'developer';
  if (roles.has(COMMUNITY_MOD_ACCESS_ROLE_ID) || roles.has(TRUSTED_CREATOR_ROLE_ID)) {
    return 'community dev';
  }
  if (ents.has('beta') || roles.has(ENGINE_BETA_ROLE_ID)) return 'beta';
  if (ents.has('pro') || roles.has(ENGINE_PRO_ROLE_ID)) return 'pro';
  return 'free';
}

export function mergeFeatureAccess(partial?: Partial<FeatureAccess> | null): FeatureAccess {
  const merged: FeatureAccess = { ...defaultFeatureAccess };
  if (!partial) return merged;
  for (const key of Object.keys(defaultFeatureAccess) as FeatureKey[]) {
    const rule = partial[key];
    if (rule && typeof rule === 'object') {
      merged[key] = {
        ...defaultFeatureAccess[key],
        ...rule,
        role_ids: Array.isArray(rule.role_ids) ? rule.role_ids : defaultFeatureAccess[key].role_ids,
        entitlements: Array.isArray(rule.entitlements)
          ? rule.entitlements
          : defaultFeatureAccess[key].entitlements,
      };
    }
  }
  return merged;
}
