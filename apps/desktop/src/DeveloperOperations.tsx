import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { motion } from 'motion/react';
import { FileUp, Puzzle, Trash2, Users } from 'lucide-react';
import { apiRequest } from './api';
import { CustomSelect } from './CustomSelect';
import { modUploadPayload } from './modUpload';
import type { FeatureKey, FeatureRule } from './featureAccess';

type Operations = {
  countdown: { enabled: boolean; title: string; target_at: string | null };
  menu: { status: 'operational' | 'degraded' | 'maintenance' | 'offline'; message: string };
  pricing: PlansPricing;
  checks: { name: string; status: string; detail: string }[];
  feature_access: Record<FeatureKey, FeatureRule>;
  available_roles: DiscordRole[];
  usage_stats?: {
    generated_at: string;
    items: { feature: string; events: number; unique_users: number }[];
  };
};

type PlansPricing = {
  lifetime_usd: number;
  lifetime_on_sale: boolean;
  lifetime_sale_name: string;
  lifetime_was_usd: number | null;
  bundle_usd: number;
  bundle_on_sale: boolean;
  bundle_sale_name: string;
  bundle_was_usd: number | null;
  tracker_solo_usd: number;
  tracker_solo_on_sale: boolean;
  tracker_solo_sale_name: string;
  tracker_solo_was_usd: number | null;
  robux_price: number;
  robux_on_sale: boolean;
  robux_sale_name: string;
  robux_was_price: number | null;
  bundle_robux_price: number;
  bundle_robux_on_sale: boolean;
  bundle_robux_sale_name: string;
  bundle_robux_was_price: number | null;
};

const defaultPricing: PlansPricing = {
  lifetime_usd: 14,
  lifetime_on_sale: false,
  lifetime_sale_name: '',
  lifetime_was_usd: null,
  bundle_usd: 25,
  bundle_on_sale: false,
  bundle_sale_name: '',
  bundle_was_usd: null,
  tracker_solo_usd: 20,
  tracker_solo_on_sale: false,
  tracker_solo_sale_name: '',
  tracker_solo_was_usd: null,
  robux_price: 2500,
  robux_on_sale: false,
  robux_sale_name: '',
  robux_was_price: null,
  bundle_robux_price: 3250,
  bundle_robux_on_sale: false,
  bundle_robux_sale_name: '',
  bundle_robux_was_price: null,
};

type DiscordRole = { id: string; name: string; color: string; position: number };
type OpsTab = 'access' | 'pricing' | 'community' | 'catalog' | 'status';
const featureLabels: Record<FeatureKey, [string, string]> = {
  app_access: ['App access', 'Signed-in members can open Engine at all.'],
  developer_panel: ['Developer panel', 'Who can open and unlock these tools.'],
  studio: ['ii Studio', 'Built-in coding environment.'],
  mod_library: ['Mod Library', 'Local mods browse / import / enable.'],
  community_mods: ['Community mods', 'Community DLL catalog downloads.'],
  community_chat: ['Community tab', 'Community server tab (chat + announcements).'],
  community_posts: ['Chat posting', 'Who can send community chat messages.'],
  launch_game: ['Game launching', 'Home launch and Studio Build & Play.'],
  health_repair: ['Health & Repair', 'Install scans, repairs, recovery.'],
  announcements: ['Announcements', 'Announcement channels in Community.'],
  backups: ['Backups', 'Backup inventory and restore.'],
  creator_application: ['Creator applications', 'Legacy creator approval form.'],
  plans_tab: [
    'Plans tab',
    'Disable to hide Plans entirely. When enabled, every signed-in member can open it to buy.',
  ],
  tracker: [
    'Player Tracker use',
    'Who gets the live board. Everyone can still open the blurred teaser when enabled.',
  ],
  target_tracker: [
    'Target Tracker use',
    'Who gets the live watchlist. Others see the blurred teaser when enabled.',
  ],
  tracker_scout: [
    'Tracker Scout use',
    'Who can ask Scout. Others see the blurred teaser when enabled.',
  ],
  self_tracker: ['Self Tracker', 'Personal presence / share tools.'],
  soundlab: ['SoundLab', 'ii SoundLab page (defaults to Pro).'],
  customize: ['Customize', 'Themes, icons, layout (defaults to Pro).'],
  catalog: ['Catalog', 'Menu feature catalog browser.'],
  home_ai: ['Home AI', 'Home assistant chat (defaults to Pro).'],
};
const FEATURE_GROUPS: { title: string; hint: string; keys: FeatureKey[] }[] = [
  {
    title: 'Core',
    hint: 'App shell and staff surfaces',
    keys: ['app_access', 'developer_panel', 'plans_tab', 'catalog'],
  },
  {
    title: 'Play & tools',
    hint: 'Launch, repair, mods, Studio',
    keys: ['launch_game', 'health_repair', 'backups', 'mod_library', 'studio'],
  },
  {
    title: 'Tracker',
    hint: 'Set Player Tracker to Everyone for launch day if you want',
    keys: ['tracker', 'target_tracker', 'tracker_scout', 'self_tracker'],
  },
  {
    title: 'Pro surfaces',
    hint: 'Defaults to Engine Pro entitlement',
    keys: ['soundlab', 'customize', 'home_ai'],
  },
  {
    title: 'Community',
    hint: 'Chat, announcements, community mods',
    keys: [
      'community_chat',
      'community_posts',
      'announcements',
      'community_mods',
      'creator_application',
    ],
  },
];

const TRACKER_BULK_KEYS: FeatureKey[] = [
  'tracker',
  'target_tracker',
  'tracker_scout',
  'self_tracker',
];
const PRO_BULK_KEYS: FeatureKey[] = ['soundlab', 'customize', 'home_ai'];

const AUDIENCE_OPTIONS = [
  { value: 'everyone', label: 'Every signed-in member' },
  { value: 'roles', label: 'Selected Discord roles' },
  { value: 'disabled', label: 'Disabled for everyone' },
] as const;

type AudienceMode = 'everyone' | 'roles' | 'disabled';

const FALLBACK_RULE: FeatureRule = {
  enabled: true,
  everyone: true,
  role_ids: [],
  entitlements: [],
};

function audienceMode(rule: FeatureRule | undefined): AudienceMode {
  if (!rule?.enabled) return 'disabled';
  if (rule.everyone) return 'everyone';
  return 'roles';
}

function ruleForAudience(
  base: FeatureRule | undefined,
  mode: AudienceMode,
  roleIds?: string[],
  entitlements?: string[],
): FeatureRule {
  const prior = base ?? FALLBACK_RULE;
  return {
    enabled: mode !== 'disabled',
    everyone: mode === 'everyone',
    role_ids: roleIds ?? prior.role_ids,
    entitlements: entitlements ?? prior.entitlements,
  };
}

function bulkAudienceMode(
  access: Record<FeatureKey, FeatureRule>,
  keys: FeatureKey[],
): { mode: AudienceMode; mixed: boolean } {
  const modes = keys.map((key) => audienceMode(access[key]));
  const mode = modes[0] ?? 'everyone';
  return { mode, mixed: !modes.every((entry) => entry === mode) };
}

function bulkSharedIds(
  access: Record<FeatureKey, FeatureRule>,
  keys: FeatureKey[],
  field: 'role_ids' | 'entitlements',
) {
  const lists = keys.map((key) => access[key]?.[field] ?? []);
  if (!lists.length) return [] as string[];
  return lists[0]!.filter((id) => lists.every((list) => list.includes(id)));
}

const ENTITLEMENT_OPTIONS = [
  'beta',
  'full_access',
  'pro',
  'ii_tracker',
  'ii_tracker_beta',
  'developer',
  'admin',
  'owner',
  'uncapped',
] as const;

type CreatorApplication = {
  id: string;
  pitch: string;
  experience: string;
  status: string;
  created_at: string;
  author: { id: string; display_name: string; avatar: string | null; discord_id: string };
};

type PendingCommunityMod = {
  id: string;
  name: string;
  description: string;
  filename: string;
  sha256: string;
  byte_size: number;
  created_at: string;
  status: string;
  author: { id: string; display_name: string; discord_id: string };
};

type TrustedMod = {
  id: string;
  name: string;
  description: string;
  filename: string;
  sha256: string;
  byte_size: number;
};
type StudioTemplate = TrustedMod;

export function DeveloperOperations({
  token,
  busy,
  enabled: _enabled,
  perform,
}: {
  token: string;
  busy: boolean;
  enabled: boolean;
  perform: (action: () => Promise<void>) => void;
}) {
  const [data, setData] = useState<Operations | null>(null);
  const [opsTab, setOpsTab] = useState<OpsTab>('access');
  const [notice, setNotice] = useState('');
  const [mods, setMods] = useState<TrustedMod[]>([]);
  const [modName, setModName] = useState('');
  const [modDescription, setModDescription] = useState('');
  const [modFile, setModFile] = useState<File | null>(null);
  const [modThumb, setModThumb] = useState<File | null>(null);
  const [templates, setTemplates] = useState<StudioTemplate[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [creatorApps, setCreatorApps] = useState<CreatorApplication[]>([]);
  const [pendingMods, setPendingMods] = useState<PendingCommunityMod[]>([]);
  const [approvedMods, setApprovedMods] = useState<PendingCommunityMod[]>([]);
  const [tracks, setTracks] = useState<
    { id: string; title: string; artist: string; filename: string; byte_size: number }[]
  >([]);
  const [trackTitle, setTrackTitle] = useState('');
  const [trackArtist, setTrackArtist] = useState('');
  const [trackFile, setTrackFile] = useState<File | null>(null);
  const trackFileInput = useRef<HTMLInputElement>(null);
  const modFileInput = useRef<HTMLInputElement>(null);
  const templateFileInput = useRef<HTMLInputElement>(null);
  const request = useCallback(
    async (path: string, body?: unknown) => {
      const response = await apiRequest(
        `/v1/developer/${path}`,
        {
          method: body ? 'POST' : 'GET',
          headers: { 'Content-Type': 'application/json', 'X-Developer-Token': token },
          body: body ? JSON.stringify(body) : undefined,
        },
        false,
      );
      return response.json();
    },
    [token],
  );
  const load = useCallback(async () => {
    setNotice('');
    const settled = await Promise.allSettled([
      request('operations'),
      request('trusted-mods'),
      request('studio-templates'),
      request('creator-applications'),
      request('community-mods'),
      request('background-tracks'),
    ]);
    const [ops, modsResult, templatesResult, creatorsResult, communityResult, tracksResult] =
      settled;
    const failures: string[] = [];
    if (ops.status === 'fulfilled') {
      const result = ops.value;
      if (Array.isArray(result?.checks) && result.countdown && result.menu) {
        setData({
          ...result,
          pricing: { ...defaultPricing, ...(result.pricing ?? {}) },
        });
      } else failures.push('operations payload incomplete');
    } else {
      failures.push(ops.reason instanceof Error ? ops.reason.message : 'operations unavailable');
    }
    if (modsResult.status === 'fulfilled' && Array.isArray(modsResult.value?.items)) {
      setMods(modsResult.value.items);
    } else if (modsResult.status === 'rejected') {
      failures.push('trusted mods');
    }
    if (templatesResult.status === 'fulfilled' && Array.isArray(templatesResult.value?.items)) {
      setTemplates(templatesResult.value.items);
    } else if (templatesResult.status === 'rejected') {
      failures.push('studio templates');
    }
    if (creatorsResult.status === 'fulfilled' && Array.isArray(creatorsResult.value?.items)) {
      setCreatorApps(creatorsResult.value.items);
    }
    if (communityResult.status === 'fulfilled' && Array.isArray(communityResult.value?.items)) {
      const items = communityResult.value.items as PendingCommunityMod[];
      setPendingMods(items.filter((item) => item.status === 'pending'));
      setApprovedMods(items.filter((item) => item.status === 'approved'));
    }
    if (tracksResult.status === 'fulfilled' && Array.isArray(tracksResult.value?.items)) {
      setTracks(tracksResult.value.items);
    } else if (tracksResult.status === 'rejected') {
      failures.push('background tracks');
    }
    if (failures.length) {
      setNotice(`Some developer panels failed to load (${failures.join(', ')}). Try Refresh.`);
    }
  }, [request]);
  useEffect(() => {
    void load();
  }, [load]);
  const run = (action: () => Promise<void>) =>
    perform(async () => {
      setNotice('');
      await action();
    });
  const updateFeature = (key: FeatureKey, next: FeatureRule) =>
    setData((current) =>
      current
        ? { ...current, feature_access: { ...current.feature_access, [key]: next } }
        : current,
    );
  const updateFeaturesBulk = (keys: FeatureKey[], next: FeatureRule) =>
    setData((current) => {
      if (!current) return current;
      const feature_access = { ...current.feature_access };
      for (const key of keys) {
        feature_access[key] = {
          enabled: next.enabled,
          everyone: next.everyone,
          role_ids: [...next.role_ids],
          entitlements: [...next.entitlements],
        };
      }
      return { ...current, feature_access };
    });

  return (
    <motion.section
      className="panel operations-panel"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="operations-heading">
        <div>
          <span className="eyebrow">Platform operations</span>
          <h2>Developer controls</h2>
          <p>Access, pricing, community review, and catalog — one tab at a time.</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {!data && !notice && (
        <p className="empty-row" role="status">
          Loading platform controls… Hit Refresh if this stays empty.
        </p>
      )}
      <div className="ops-tabs" role="tablist" aria-label="Developer control sections">
        {(
          [
            ['access', 'Access'],
            ['pricing', 'Pricing'],
            ['community', 'Community'],
            ['catalog', 'Catalog'],
            ['status', 'Status'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={opsTab === id}
            className={opsTab === id ? 'is-active' : ''}
            onClick={() => setOpsTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {opsTab === 'community' && (
        <>
          <section className="creator-review-panel">
            <div className="operations-heading">
              <div>
                <span className="eyebrow">Community mods</span>
                <h3>Pending mod reviews</h3>
                <p>
                  Mods submitted from Mod Library → Community land here. Approve to list them under
                  Community mods; reject to drop them.
                </p>
              </div>
              <span className="status-pill">{pendingMods.length} pending</span>
            </div>
            {pendingMods.length ? (
              <div className="creator-review-list">
                {pendingMods.map((item) => (
                  <article key={item.id} className="panel">
                    <header>
                      <strong>{item.name}</strong>
                      <small>
                        {item.author.display_name} · {item.filename} ·{' '}
                        {Math.max(1, Math.round(item.byte_size / 1024))} KB
                      </small>
                    </header>
                    <p>{item.description}</p>
                    <code title={item.sha256}>SHA-256 {item.sha256.slice(0, 16)}…</code>
                    <div className="creator-review-actions">
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await request(`community-mods/${item.id}/review`, {
                              approve: true,
                              note: '',
                            });
                            await load();
                            setNotice(`Approved ${item.name} for the community mods list.`);
                          })
                        }
                      >
                        Approve for Community
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await request(`community-mods/${item.id}/review`, {
                              approve: false,
                              note: 'Does not meet community guidelines',
                            });
                            await load();
                            setNotice(`Rejected ${item.name}.`);
                          })
                        }
                      >
                        Reject
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await apiRequest(`/v1/developer/community-mods/${item.id}`, {
                              method: 'DELETE',
                              headers: { 'X-Developer-Token': token },
                            });
                            await load();
                            setNotice(`${item.name} was deleted.`);
                          })
                        }
                      >
                        <Trash2 size={15} /> Delete
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="empty-row">No community mods waiting for review.</p>
            )}
          </section>

          <section className="creator-review-panel">
            <div className="operations-heading">
              <div>
                <span className="eyebrow">Community mods</span>
                <h3>Live community catalog</h3>
                <p>
                  Approved community DLLs. Delete removes them from the member Mod Library list.
                </p>
              </div>
              <span className="status-pill">{approvedMods.length} live</span>
            </div>
            {approvedMods.length ? (
              <div className="creator-review-list">
                {approvedMods.map((item) => (
                  <article key={item.id} className="panel">
                    <header>
                      <strong>{item.name}</strong>
                      <small>
                        {item.author.display_name} · {item.filename} ·{' '}
                        {Math.max(1, Math.round(item.byte_size / 1024))} KB
                      </small>
                    </header>
                    <p>{item.description}</p>
                    <div className="creator-review-actions">
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await apiRequest(`/v1/developer/community-mods/${item.id}`, {
                              method: 'DELETE',
                              headers: { 'X-Developer-Token': token },
                            });
                            await load();
                            setNotice(`${item.name} was removed from community mods.`);
                          })
                        }
                      >
                        <Trash2 size={15} /> Delete
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="empty-row">No approved community mods yet.</p>
            )}
          </section>

          {!!creatorApps.length && (
            <section className="creator-review-panel">
              <div className="operations-heading">
                <div>
                  <span className="eyebrow">Community creators</span>
                  <h3>Pending applications</h3>
                  <p>
                    Legacy creator applications. New uploads go through Pending mod reviews above.
                    Anyone can submit a DLL for review without this form.
                  </p>
                </div>
              </div>
              <div className="creator-review-list">
                {creatorApps.map((item) => (
                  <article key={item.id} className="panel">
                    <header>
                      <strong>{item.author.display_name}</strong>
                      <small>{item.author.discord_id}</small>
                    </header>
                    <p>
                      <strong>Pitch</strong> {item.pitch}
                    </p>
                    <p>
                      <strong>Experience</strong> {item.experience}
                    </p>
                    <div className="creator-review-actions">
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await request(`creator-applications/${item.id}/review`, {
                              approve: true,
                              note: '',
                            });
                            await load();
                            setNotice(
                              `Approved ${item.author.display_name} as a community creator.`,
                            );
                          })
                        }
                      >
                        Approve + grant role
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await request(`creator-applications/${item.id}/review`, {
                              approve: false,
                              note: 'Needs more detail',
                            });
                            await load();
                            setNotice(`Rejected ${item.author.display_name}.`);
                          })
                        }
                      >
                        Reject
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {opsTab === 'access' && data?.feature_access && (
        <section className="feature-access-manager">
          <div className="operations-heading">
            <div>
              <span className="eyebrow">Discord access</span>
              <h3>Feature permissions</h3>
              <p>
                Who can see and use each Engine surface. Tracker pages honor these rules — set
                Player Tracker to Everyone for launch day if you want a public open.
              </p>
            </div>
            <Users size={28} />
          </div>
          <div className="feature-access-groups">
            <div className="feature-access-group">
              <header className="feature-access-group-head">
                <strong>Bulk updates</strong>
                <span>Apply one audience to every Tracker feature, or every Pro surface</span>
              </header>
              <div className="feature-access-grid">
                {(
                  [
                    {
                      id: 'tracker-bulk',
                      title: 'All Tracker features',
                      hint: 'Updates Player Tracker, Target Tracker, Tracker Scout, and Self Tracker together.',
                      keys: TRACKER_BULK_KEYS,
                    },
                    {
                      id: 'pro-bulk',
                      title: 'All Pro features',
                      hint: 'Updates SoundLab, Customize, and Home AI together.',
                      keys: PRO_BULK_KEYS,
                    },
                  ] as const
                ).map((bulk) => {
                  const { mode, mixed } = bulkAudienceMode(data.feature_access, bulk.keys);
                  const sharedRoles = bulkSharedIds(data.feature_access, bulk.keys, 'role_ids');
                  const sharedEntitlements = bulkSharedIds(
                    data.feature_access,
                    bulk.keys,
                    'entitlements',
                  );
                  const seed = data.feature_access[bulk.keys[0]!] ?? FALLBACK_RULE;
                  return (
                    <article className="feature-access-card feature-access-bulk" key={bulk.id}>
                      <div>
                        <strong>{bulk.title}</strong>
                        <p>
                          {bulk.hint}
                          {mixed
                            ? ' Current settings differ — picking a value here syncs every listed feature.'
                            : ''}
                        </p>
                      </div>
                      <CustomSelect
                        label={`${bulk.title} audience`}
                        value={mode}
                        onChange={(value) => {
                          const nextMode = value as AudienceMode;
                          updateFeaturesBulk(
                            [...bulk.keys],
                            ruleForAudience(seed, nextMode, sharedRoles, sharedEntitlements),
                          );
                        }}
                        options={[...AUDIENCE_OPTIONS]}
                      />
                      {mode === 'roles' && (
                        <div className="feature-role-list">
                          {data.available_roles.map((role) => (
                            <label
                              key={role.id}
                              style={{ '--role-color': role.color } as CSSProperties}
                            >
                              <input
                                type="checkbox"
                                checked={sharedRoles.includes(role.id)}
                                onChange={(event) => {
                                  const role_ids = event.target.checked
                                    ? [...new Set([...sharedRoles, role.id])]
                                    : sharedRoles.filter((id) => id !== role.id);
                                  updateFeaturesBulk(
                                    [...bulk.keys],
                                    ruleForAudience(seed, 'roles', role_ids, sharedEntitlements),
                                  );
                                }}
                              />
                              <span /> {role.name}
                            </label>
                          ))}
                          {ENTITLEMENT_OPTIONS.map((entitlement) => (
                            <label key={entitlement}>
                              <input
                                type="checkbox"
                                checked={sharedEntitlements.includes(entitlement)}
                                onChange={(event) => {
                                  const entitlements = event.target.checked
                                    ? [...new Set([...sharedEntitlements, entitlement])]
                                    : sharedEntitlements.filter((name) => name !== entitlement);
                                  updateFeaturesBulk(
                                    [...bulk.keys],
                                    ruleForAudience(seed, 'roles', sharedRoles, entitlements),
                                  );
                                }}
                              />
                              {entitlement.replaceAll('_', ' ')} entitlement
                            </label>
                          ))}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>
            {FEATURE_GROUPS.map((group) => (
              <div className="feature-access-group" key={group.title}>
                <header className="feature-access-group-head">
                  <strong>{group.title}</strong>
                  <span>{group.hint}</span>
                </header>
                <div className="feature-access-grid">
                  {group.keys.map((key) => {
                    const rule = data.feature_access[key] ?? FALLBACK_RULE;
                    const mode = audienceMode(rule);
                    return (
                      <article className="feature-access-card" key={key}>
                        <div>
                          <strong>{featureLabels[key][0]}</strong>
                          <p>{featureLabels[key][1]}</p>
                        </div>
                        <CustomSelect
                          label={`${featureLabels[key][0]} audience`}
                          value={mode}
                          onChange={(value) =>
                            updateFeature(key, ruleForAudience(rule, value as AudienceMode))
                          }
                          options={[...AUDIENCE_OPTIONS]}
                        />
                        {mode === 'roles' && (
                          <div className="feature-role-list">
                            {data.available_roles.map((role) => (
                              <label
                                key={role.id}
                                style={{ '--role-color': role.color } as CSSProperties}
                              >
                                <input
                                  type="checkbox"
                                  checked={rule.role_ids.includes(role.id)}
                                  onChange={(event) =>
                                    updateFeature(key, {
                                      ...rule,
                                      role_ids: event.target.checked
                                        ? [...rule.role_ids, role.id]
                                        : rule.role_ids.filter((id) => id !== role.id),
                                    })
                                  }
                                />
                                <span /> {role.name}
                              </label>
                            ))}
                            {ENTITLEMENT_OPTIONS.map((entitlement) => (
                              <label key={entitlement}>
                                <input
                                  type="checkbox"
                                  checked={rule.entitlements.includes(entitlement)}
                                  onChange={(event) =>
                                    updateFeature(key, {
                                      ...rule,
                                      entitlements: event.target.checked
                                        ? [...rule.entitlements, entitlement]
                                        : rule.entitlements.filter((name) => name !== entitlement),
                                    })
                                  }
                                />
                                {entitlement.replaceAll('_', ' ')} entitlement
                              </label>
                            ))}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const incomplete = (Object.keys(featureLabels) as FeatureKey[]).find((key) => {
                  const rule = data.feature_access[key];
                  return (
                    rule?.enabled &&
                    !rule.everyone &&
                    !(rule.role_ids?.length || rule.entitlements?.length)
                  );
                });
                if (incomplete) {
                  throw new Error(
                    `Pick at least one Discord role or entitlement for ${featureLabels[incomplete][0]} before saving.`,
                  );
                }
                await request('operations/features', data.feature_access);
                await load();
                setNotice('Feature permissions saved. Connected apps refresh within one minute.');
              })
            }
          >
            Save feature permissions
          </button>
        </section>
      )}

      {opsTab === 'catalog' && (
        <>
          <form
            className="trusted-mod-manager"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                if (!modFile) throw new Error('Choose the trusted mod DLL first.');
                const { headers, body } = await modUploadPayload(modFile, modThumb);
                headers['X-Developer-Token'] = token;
                const response = await apiRequest(
                  `/v1/developer/trusted-mods?name=${encodeURIComponent(modName)}&description=${encodeURIComponent(modDescription)}&filename=${encodeURIComponent(modFile.name)}`,
                  {
                    method: 'POST',
                    headers,
                    body,
                  },
                  false,
                );
                if (!response.ok) throw new Error('Could not publish the trusted mod.');
                setModName('');
                setModDescription('');
                setModFile(null);
                setModThumb(null);
                if (modFileInput.current) modFileInput.current.value = '';
                await load();
                setNotice('Trusted mod added to the member Mod Library catalog.');
              });
            }}
          >
            <div className="operations-heading">
              <div>
                <span className="eyebrow">Mod Library catalog</span>
                <h3>Trusted mods</h3>
                <p>Add verified DLLs that signed-in members can install from the app.</p>
              </div>
              <Puzzle size={28} />
            </div>
            <div className="trusted-mod-form-grid">
              <label className="developer-field">
                Mod name
                <input
                  required
                  maxLength={120}
                  value={modName}
                  onChange={(event) => setModName(event.target.value)}
                  placeholder="Trusted mod name"
                />
              </label>
              <label className="developer-field">
                DLL file
                <input
                  ref={modFileInput}
                  required
                  type="file"
                  accept=".dll,application/octet-stream"
                  onChange={(event) => setModFile(event.target.files?.[0] ?? null)}
                />
              </label>
              <label className="developer-field">
                Thumbnail (optional)
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(event) => setModThumb(event.target.files?.[0] ?? null)}
                />
              </label>
              <label className="developer-field trusted-mod-description">
                Description
                <textarea
                  required
                  rows={3}
                  maxLength={1000}
                  value={modDescription}
                  onChange={(event) => setModDescription(event.target.value)}
                  placeholder="What this mod does and anything members should know."
                />
              </label>
            </div>
            <button className="primary" disabled={busy || !modFile}>
              Add trusted mod
            </button>
            {!!mods.length && (
              <div className="developer-mod-list">
                {mods.map((mod) => (
                  <article key={mod.id}>
                    <div>
                      <strong>{mod.name}</strong>
                      <small>
                        {mod.filename} · {(mod.byte_size / 1_048_576).toFixed(2)} MB
                      </small>
                      <p>{mod.description}</p>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await apiRequest(`/v1/developer/trusted-mods/${mod.id}`, {
                            method: 'DELETE',
                            headers: { 'X-Developer-Token': token },
                          });
                          await load();
                          setNotice(`${mod.name} was removed from the trusted catalog.`);
                        })
                      }
                    >
                      <Trash2 size={15} /> Remove
                    </button>
                  </article>
                ))}
              </div>
            )}
          </form>

          <form
            className="trusted-mod-manager background-track-manager"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                if (!trackFile) throw new Error('Choose an MP3 first.');
                if (!trackFile.name.toLowerCase().endsWith('.mp3')) {
                  throw new Error('Upload an MP3 file.');
                }
                const response = await apiRequest(
                  `/v1/developer/background-tracks?title=${encodeURIComponent(trackTitle)}&artist=${encodeURIComponent(trackArtist)}&filename=${encodeURIComponent(trackFile.name)}`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/octet-stream',
                      'X-Developer-Token': token,
                    },
                    body: trackFile,
                  },
                  false,
                );
                if (!response.ok) throw new Error('Could not publish the track.');
                setTrackTitle('');
                setTrackArtist('');
                setTrackFile(null);
                if (trackFileInput.current) trackFileInput.current.value = '';
                await load();
                setNotice('Background track added for every member playlist.');
              });
            }}
          >
            <div className="operations-heading">
              <div>
                <span className="eyebrow">Background music</span>
                <h3>Preset engine tracks</h3>
                <p>
                  Quiet MP3 presets (max 8 MB each). Members can play these in Engine or import
                  their own local songs.
                </p>
              </div>
              <span className="status-pill">{tracks.length} tracks</span>
            </div>
            <div className="trusted-mod-fields">
              <label className="developer-field">
                Track title
                <input
                  required
                  maxLength={120}
                  value={trackTitle}
                  onChange={(event) => setTrackTitle(event.target.value)}
                />
              </label>
              <label className="developer-field">
                Track artist
                <input
                  maxLength={120}
                  value={trackArtist}
                  onChange={(event) => setTrackArtist(event.target.value)}
                  placeholder="Optional"
                />
              </label>
              <label className="developer-field">
                MP3 file
                <input
                  ref={trackFileInput}
                  type="file"
                  accept="audio/mpeg,.mp3"
                  required
                  onChange={(event) => setTrackFile(event.target.files?.[0] ?? null)}
                />
              </label>
            </div>
            <button className="primary" disabled={busy || !trackFile}>
              Upload preset track
            </button>
            {!!tracks.length && (
              <div className="developer-mod-list">
                {tracks.map((track) => (
                  <article key={track.id}>
                    <div>
                      <strong>{track.title}</strong>
                      <small>
                        {track.artist || 'ii Engine'} · {track.filename} ·{' '}
                        {(track.byte_size / 1_048_576).toFixed(2)} MB
                      </small>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await apiRequest(`/v1/developer/background-tracks/${track.id}`, {
                            method: 'DELETE',
                            headers: { 'X-Developer-Token': token },
                          });
                          await load();
                          setNotice(`${track.title} was removed from the preset playlist.`);
                        })
                      }
                    >
                      <Trash2 size={15} /> Remove
                    </button>
                  </article>
                ))}
              </div>
            )}
          </form>

          <form
            className="trusted-mod-manager"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                if (!templateFile) throw new Error('Choose the ii template ZIP first.');
                const response = await apiRequest(
                  `/v1/developer/studio-templates?name=${encodeURIComponent(templateName)}&description=${encodeURIComponent(templateDescription)}&filename=${encodeURIComponent(templateFile.name)}`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/zip', 'X-Developer-Token': token },
                    body: templateFile,
                  },
                  false,
                );
                if (!response.ok) throw new Error('Could not upload the ii template.');
                setTemplateName('');
                setTemplateDescription('');
                setTemplateFile(null);
                if (templateFileInput.current) templateFileInput.current.value = '';
                await load();
                setNotice('ii template uploaded. Studio members can now use it for new projects.');
              });
            }}
          >
            <div className="operations-heading">
              <div>
                <span className="eyebrow">ii Studio project source</span>
                <h3>ii templates</h3>
                <p>
                  Upload a safe ZIP containing C# source and a .csproj for members to start from.
                </p>
              </div>
              <FileUp size={28} />
            </div>
            <div className="trusted-mod-form-grid">
              <label className="developer-field">
                Template name
                <input
                  required
                  maxLength={120}
                  value={templateName}
                  onChange={(event) => setTemplateName(event.target.value)}
                  placeholder="Starter template"
                />
              </label>
              <label className="developer-field">
                Template ZIP
                <input
                  ref={templateFileInput}
                  required
                  type="file"
                  accept=".zip,application/zip"
                  onChange={(event) => setTemplateFile(event.target.files?.[0] ?? null)}
                />
              </label>
              <label className="developer-field trusted-mod-description">
                Description
                <textarea
                  required
                  rows={3}
                  maxLength={1000}
                  value={templateDescription}
                  onChange={(event) => setTemplateDescription(event.target.value)}
                  placeholder="Who this starting template is for."
                />
              </label>
            </div>
            <button className="primary" disabled={busy || !templateFile}>
              Upload ii template
            </button>
            {!!templates.length && (
              <div className="developer-mod-list">
                {templates.map((template) => (
                  <article key={template.id}>
                    <div>
                      <strong>{template.name}</strong>
                      <small>
                        {template.filename} · {(template.byte_size / 1_048_576).toFixed(2)} MB
                      </small>
                      <p>{template.description}</p>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await apiRequest(`/v1/developer/studio-templates/${template.id}`, {
                            method: 'DELETE',
                            headers: { 'X-Developer-Token': token },
                          });
                          await load();
                          setNotice(`${template.name} was removed from ii Studio.`);
                        })
                      }
                    >
                      <Trash2 size={15} /> Remove
                    </button>
                  </article>
                ))}
              </div>
            )}
          </form>
        </>
      )}

      {opsTab === 'pricing' && (
        <div className="ops-pricing-panel">
          <form
            className="ops-pricing-form"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                if (!data) return;
                await request('operations/pricing', data.pricing);
                await load();
                setNotice('Plans pricing saved for connected apps.');
              });
            }}
          >
            <div className="operations-heading">
              <div>
                <span className="eyebrow">Plans</span>
                <h3>Pricing & sales</h3>
                <p>
                  USD and Robux list prices for Engine Pro, Tracker solo, and Pro+Tracker. Sale
                  toggles drive Plans strikethrough + sale text. Weekend Robux auto-sale still
                  overrides the bundle Robux price while live.
                </p>
              </div>
            </div>
            <p className="ops-pricing-group">Engine Pro lifetime (USD)</p>
            <label className="developer-field">
              Pro lifetime USD
              <input
                type="number"
                min={1}
                max={999}
                value={data?.pricing.lifetime_usd ?? 14}
                onChange={(event) =>
                  data &&
                  setData({
                    ...data,
                    pricing: {
                      ...data.pricing,
                      lifetime_usd: Number(event.target.value) || 1,
                    },
                  })
                }
              />
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={data?.pricing.lifetime_on_sale ?? false}
                onChange={(event) =>
                  data &&
                  setData({
                    ...data,
                    pricing: {
                      ...data.pricing,
                      lifetime_on_sale: event.target.checked,
                      lifetime_sale_name: event.target.checked
                        ? data.pricing.lifetime_sale_name
                        : '',
                      lifetime_was_usd: event.target.checked ? data.pricing.lifetime_was_usd : null,
                    },
                  })
                }
              />{' '}
              Lifetime on sale
            </label>
            {(data?.pricing.lifetime_on_sale ?? false) && (
              <>
                <label className="developer-field">
                  Lifetime sale text (under price)
                  <input
                    placeholder="e.g. Spring Launch Sale, ends Friday"
                    value={data?.pricing.lifetime_sale_name ?? ''}
                    onChange={(event) =>
                      data &&
                      setData({
                        ...data,
                        pricing: { ...data.pricing, lifetime_sale_name: event.target.value },
                      })
                    }
                  />
                </label>
                <label className="developer-field">
                  Lifetime was-price USD (optional strikethrough)
                  <input
                    type="number"
                    min={1}
                    max={999}
                    placeholder="Higher than sale price"
                    value={data?.pricing.lifetime_was_usd ?? ''}
                    onChange={(event) =>
                      data &&
                      setData({
                        ...data,
                        pricing: {
                          ...data.pricing,
                          lifetime_was_usd: event.target.value
                            ? Number(event.target.value) || null
                            : null,
                        },
                      })
                    }
                  />
                </label>
              </>
            )}
            <label className="developer-field">
              Pro + Tracker bundle USD
              <input
                type="number"
                min={1}
                max={999}
                value={data?.pricing.bundle_usd ?? 25}
                onChange={(event) =>
                  data &&
                  setData({
                    ...data,
                    pricing: {
                      ...data.pricing,
                      bundle_usd: Number(event.target.value) || 1,
                    },
                  })
                }
              />
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={data?.pricing.bundle_on_sale ?? false}
                onChange={(event) =>
                  data &&
                  setData({
                    ...data,
                    pricing: {
                      ...data.pricing,
                      bundle_on_sale: event.target.checked,
                      bundle_sale_name: event.target.checked ? data.pricing.bundle_sale_name : '',
                      bundle_was_usd: event.target.checked ? data.pricing.bundle_was_usd : null,
                    },
                  })
                }
              />{' '}
              Pro + Tracker bundle on sale
            </label>
            {(data?.pricing.bundle_on_sale ?? false) && (
              <>
                <label className="developer-field">
                  Bundle sale text (under price)
                  <input
                    placeholder="e.g. Tracker pack promo"
                    value={data?.pricing.bundle_sale_name ?? ''}
                    onChange={(event) =>
                      data &&
                      setData({
                        ...data,
                        pricing: { ...data.pricing, bundle_sale_name: event.target.value },
                      })
                    }
                  />
                </label>
                <label className="developer-field">
                  Bundle was-price USD (optional strikethrough)
                  <input
                    type="number"
                    min={1}
                    max={999}
                    placeholder="Higher than sale price"
                    value={data?.pricing.bundle_was_usd ?? ''}
                    onChange={(event) =>
                      data &&
                      setData({
                        ...data,
                        pricing: {
                          ...data.pricing,
                          bundle_was_usd: event.target.value
                            ? Number(event.target.value) || null
                            : null,
                        },
                      })
                    }
                  />
                </label>
              </>
            )}
            <p className="ops-pricing-group">ii Tracker solo (USD site link)</p>
            <label className="developer-field">
              Tracker solo USD
              <input
                type="number"
                min={1}
                max={999}
                value={data?.pricing.tracker_solo_usd ?? 20}
                onChange={(event) =>
                  data &&
                  setData({
                    ...data,
                    pricing: {
                      ...data.pricing,
                      tracker_solo_usd: Number(event.target.value) || 1,
                    },
                  })
                }
              />
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={data?.pricing.tracker_solo_on_sale ?? false}
                onChange={(event) =>
                  data &&
                  setData({
                    ...data,
                    pricing: {
                      ...data.pricing,
                      tracker_solo_on_sale: event.target.checked,
                      tracker_solo_sale_name: event.target.checked
                        ? data.pricing.tracker_solo_sale_name
                        : '',
                      tracker_solo_was_usd: event.target.checked
                        ? data.pricing.tracker_solo_was_usd
                        : null,
                    },
                  })
                }
              />{' '}
              Tracker solo on sale
            </label>
            {(data?.pricing.tracker_solo_on_sale ?? false) && (
              <>
                <label className="developer-field">
                  Tracker solo sale text
                  <input
                    placeholder="e.g. Tracker Launch Sale"
                    value={data?.pricing.tracker_solo_sale_name ?? ''}
                    onChange={(event) =>
                      data &&
                      setData({
                        ...data,
                        pricing: { ...data.pricing, tracker_solo_sale_name: event.target.value },
                      })
                    }
                  />
                </label>
                <label className="developer-field">
                  Tracker solo was-price USD
                  <input
                    type="number"
                    min={1}
                    max={999}
                    placeholder="Higher than sale price"
                    value={data?.pricing.tracker_solo_was_usd ?? ''}
                    onChange={(event) =>
                      data &&
                      setData({
                        ...data,
                        pricing: {
                          ...data.pricing,
                          tracker_solo_was_usd: event.target.value
                            ? Number(event.target.value) || null
                            : null,
                        },
                      })
                    }
                  />
                </label>
              </>
            )}
            <p className="ops-pricing-group">Engine Pro lifetime (Robux)</p>
            <label className="developer-field">
              Pro lifetime Robux
              <input
                type="number"
                min={1}
                max={1000000}
                value={data?.pricing.robux_price ?? 2500}
                onChange={(event) =>
                  data &&
                  setData({
                    ...data,
                    pricing: {
                      ...data.pricing,
                      robux_price: Number(event.target.value) || 1,
                    },
                  })
                }
              />
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={data?.pricing.robux_on_sale ?? false}
                onChange={(event) =>
                  data &&
                  setData({
                    ...data,
                    pricing: {
                      ...data.pricing,
                      robux_on_sale: event.target.checked,
                      robux_sale_name: event.target.checked ? data.pricing.robux_sale_name : '',
                      robux_was_price: event.target.checked ? data.pricing.robux_was_price : null,
                    },
                  })
                }
              />{' '}
              Pro Robux on sale
            </label>
            {(data?.pricing.robux_on_sale ?? false) && (
              <>
                <label className="developer-field">
                  Robux sale text (under price)
                  <input
                    placeholder="e.g. Roblox Promo, limited time"
                    value={data?.pricing.robux_sale_name ?? ''}
                    onChange={(event) =>
                      data &&
                      setData({
                        ...data,
                        pricing: { ...data.pricing, robux_sale_name: event.target.value },
                      })
                    }
                  />
                </label>
                <label className="developer-field">
                  Robux was-price (optional strikethrough)
                  <input
                    type="number"
                    min={1}
                    max={1000000}
                    placeholder="Higher than sale price"
                    value={data?.pricing.robux_was_price ?? ''}
                    onChange={(event) =>
                      data &&
                      setData({
                        ...data,
                        pricing: {
                          ...data.pricing,
                          robux_was_price: event.target.value
                            ? Number(event.target.value) || null
                            : null,
                        },
                      })
                    }
                  />
                </label>
              </>
            )}
            <p className="ops-pricing-group">Engine Pro + ii Tracker (Robux)</p>
            <label className="developer-field">
              Pro + Tracker Robux
              <input
                type="number"
                min={1}
                max={1000000}
                value={data?.pricing.bundle_robux_price ?? 3250}
                onChange={(event) =>
                  data &&
                  setData({
                    ...data,
                    pricing: {
                      ...data.pricing,
                      bundle_robux_price: Number(event.target.value) || 1,
                    },
                  })
                }
              />
            </label>
            <p className="developer-help">
              Automatic weekend sale still forces 2,700 R$ Fri 4 PM – Sun midnight ET (asset
              140291726071649), overriding this list price while live.
            </p>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={data?.pricing.bundle_robux_on_sale ?? false}
                onChange={(event) =>
                  data &&
                  setData({
                    ...data,
                    pricing: {
                      ...data.pricing,
                      bundle_robux_on_sale: event.target.checked,
                      bundle_robux_sale_name: event.target.checked
                        ? data.pricing.bundle_robux_sale_name
                        : '',
                      bundle_robux_was_price: event.target.checked
                        ? data.pricing.bundle_robux_was_price
                        : null,
                    },
                  })
                }
              />{' '}
              Bundle Robux on sale (manual; weekends auto)
            </label>
            {(data?.pricing.bundle_robux_on_sale ?? false) && (
              <>
                <label className="developer-field">
                  Bundle Robux sale text
                  <input
                    placeholder="e.g. Bundle promo"
                    value={data?.pricing.bundle_robux_sale_name ?? ''}
                    onChange={(event) =>
                      data &&
                      setData({
                        ...data,
                        pricing: { ...data.pricing, bundle_robux_sale_name: event.target.value },
                      })
                    }
                  />
                </label>
                <label className="developer-field">
                  Bundle Robux was-price
                  <input
                    type="number"
                    min={1}
                    max={1000000}
                    value={data?.pricing.bundle_robux_was_price ?? ''}
                    onChange={(event) =>
                      data &&
                      setData({
                        ...data,
                        pricing: {
                          ...data.pricing,
                          bundle_robux_was_price: event.target.value
                            ? Number(event.target.value) || null
                            : null,
                        },
                      })
                    }
                  />
                </label>
              </>
            )}
            <button className="primary" disabled={busy || !data}>
              Save Plans pricing
            </button>
          </form>
        </div>
      )}

      {opsTab === 'status' && (
        <>
          <div className="health-check-grid">
            {data?.checks.map((check) => (
              <article className="health-check" key={check.name}>
                <span className={`health-dot ${check.status}`} />
                <div>
                  <strong>{check.name}</strong>
                  <small>{check.detail}</small>
                </div>
              </article>
            ))}
          </div>
          {data?.usage_stats && (
            <section className="usage-stats-panel">
              <div className="operations-heading">
                <div>
                  <span className="eyebrow">Product analytics</span>
                  <h3>Feature usage</h3>
                  <p>Unique users and events per app feature.</p>
                </div>
              </div>
              <div className="usage-stats-grid">
                {data.usage_stats.items.map((item) => (
                  <article key={item.feature}>
                    <strong>{item.feature.replaceAll('_', ' ')}</strong>
                    <span>
                      <b>{item.unique_users}</b> people
                    </span>
                    <small>{item.events} events</small>
                  </article>
                ))}
              </div>
            </section>
          )}
          <div className="operations-grid compact-operations">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                run(async () => {
                  if (!data) return;
                  await request('operations/countdown', data.countdown);
                  await load();
                  setNotice('Countdown saved for connected apps.');
                });
              }}
            >
              <h3>Update countdown</h3>
              <p>Show members when the next planned update becomes available.</p>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={data?.countdown.enabled ?? false}
                  onChange={(event) =>
                    data &&
                    setData({
                      ...data,
                      countdown: { ...data.countdown, enabled: event.target.checked },
                    })
                  }
                />{' '}
                Show countdown
              </label>
              <label className="developer-field">
                Member-facing label
                <input
                  value={data?.countdown.title ?? ''}
                  onChange={(event) =>
                    data &&
                    setData({
                      ...data,
                      countdown: { ...data.countdown, title: event.target.value },
                    })
                  }
                />
              </label>
              <label className="developer-field">
                Release time
                <input
                  type="datetime-local"
                  value={data?.countdown.target_at?.slice(0, 16) ?? ''}
                  onChange={(event) =>
                    data &&
                    setData({
                      ...data,
                      countdown: {
                        ...data.countdown,
                        target_at: event.target.value
                          ? new Date(event.target.value).toISOString()
                          : null,
                      },
                    })
                  }
                />
              </label>
              <button className="primary" disabled={busy}>
                Save countdown
              </button>
            </form>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                run(async () => {
                  if (!data) return;
                  await request('operations/menu', data.menu);
                  await load();
                  setNotice('Menu status updated for connected apps.');
                });
              }}
            >
              <h3>Menu status</h3>
              <p>Use this during outages or maintenance so members see an accurate status.</p>
              <label className="developer-field">
                State
                <CustomSelect
                  label="Menu status"
                  value={data?.menu.status ?? 'operational'}
                  onChange={(value) =>
                    data &&
                    setData({
                      ...data,
                      menu: {
                        ...data.menu,
                        status: value as Operations['menu']['status'],
                      },
                    })
                  }
                  options={[
                    { value: 'operational', label: 'Operational' },
                    { value: 'degraded', label: 'Degraded' },
                    { value: 'maintenance', label: 'Maintenance' },
                    { value: 'offline', label: 'Offline' },
                  ]}
                />
              </label>
              <label className="developer-field">
                Member message
                <textarea
                  rows={3}
                  value={data?.menu.message ?? ''}
                  onChange={(event) =>
                    data &&
                    setData({ ...data, menu: { ...data.menu, message: event.target.value } })
                  }
                />
              </label>
              <button className="primary" disabled={busy}>
                Update status
              </button>
            </form>
          </div>
        </>
      )}
    </motion.section>
  );
}
