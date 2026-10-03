import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Crown,
  ExternalLink,
  Grid3X3,
  LayoutGrid,
  Link2,
  Loader2,
  Minus,
  Music2,
  Radar,
  Shirt,
  ShoppingBag,
  Sparkles,
  Wand2,
} from 'lucide-react';
import PageHero from './PageHero';
import { apiRequest, errorMessage } from './api';
import { externalClick } from './external';

const SHOP_URL = 'https://iistupid.com/product/ii-engine';
const SHOP_HOME_URL = 'https://iistupid.com/';
const ROBUX_CATALOG_URL = 'https://www.roblox.com/catalog/93620103303755/ii-Engine-Pro-Lifetime';
const ROBUX_BUNDLE_CATALOG_URL =
  'https://www.roblox.com/catalog/112921567316975/ii-Engine-Pro-ii-Tracker';
const MONTHLY_PRICE_USD = 7;
const LIFETIME_PRICE_USD = 14;
const TRACKER_SOLO_PRICE_USD = 20;
const TRACKER_BUNDLE_PRICE_USD = 25;
const ROBUX_PRICE = 2500;
const ROBUX_BUNDLE_PRICE = 3250;

const PRO_SPOTLIGHT = [
  {
    name: 'Direct menu connection',
    icon: Wand2,
  },
  {
    name: 'All AI features',
    icon: Sparkles,
  },
  {
    name: 'ii SoundLab',
    icon: Music2,
  },
  {
    name: 'Self Tracker share',
    icon: Radar,
  },
  {
    name: 'Customize tab',
    icon: Crown,
  },
  {
    name: 'Grid page switcher',
    icon: Grid3X3,
  },
  {
    name: 'Background pattern',
    icon: Sparkles,
  },
  {
    name: 'Flexible Home layout',
    icon: LayoutGrid,
  },
  {
    name: 'Studio Pro window',
    icon: ShoppingBag,
  },
] as const;

type FeatureRow = {
  name: string;
  detail: string;
  free: boolean | string;
  pro: boolean | string;
};

type RobloxProduct = {
  id: string;
  asset_id: string;
  catalog_url: string;
  robux_price: number;
  product_name: string;
  grants: string[];
};

type WeekendSale = {
  active: boolean;
  timezone: string;
  window_label: string;
  price: number;
  regular_price: number;
  asset_id: string;
  catalog_url: string;
  starts_at: string;
  ends_at: string;
  next_starts_at: string;
  hint: string;
};

type RobloxStatus = {
  configured: boolean;
  catalog_url?: string | null;
  robux_price: number;
  shop_url: string;
  product_name?: string;
  linked: boolean;
  roblox_username: string | null;
  claimed: boolean;
  claimed_at: string | null;
  claimed_grants?: string[];
  robux_on_sale?: boolean;
  robux_sale_name?: string;
  robux_was_price?: number | null;
  bundle_asset_id?: string;
  bundle_catalog_url?: string | null;
  bundle_robux_price?: number;
  bundle_product_name?: string;
  bundle_robux_on_sale?: boolean;
  bundle_robux_sale_name?: string;
  bundle_robux_was_price?: number | null;
  weekend_sale?: WeekendSale;
  weekend_claim_pending?: boolean;
  owns_weekend_item?: boolean;
  products?: RobloxProduct[];
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

const ROBUX_WEEKEND_PRICE = 2700;

const defaultPricing: PlansPricing = {
  lifetime_usd: LIFETIME_PRICE_USD,
  lifetime_on_sale: false,
  lifetime_sale_name: '',
  lifetime_was_usd: null,
  bundle_usd: TRACKER_BUNDLE_PRICE_USD,
  bundle_on_sale: false,
  bundle_sale_name: '',
  bundle_was_usd: null,
  tracker_solo_usd: TRACKER_SOLO_PRICE_USD,
  tracker_solo_on_sale: false,
  tracker_solo_sale_name: '',
  tracker_solo_was_usd: null,
  robux_price: ROBUX_PRICE,
  robux_on_sale: false,
  robux_sale_name: '',
  robux_was_price: null,
  bundle_robux_price: ROBUX_BUNDLE_PRICE,
  bundle_robux_on_sale: false,
  bundle_robux_sale_name: '',
  bundle_robux_was_price: null,
};

function demoWeekendSale(): WeekendSale {
  return {
    active: false,
    timezone: 'America/New_York',
    window_label: 'Fri 4 PM – Sun midnight ET',
    price: ROBUX_WEEKEND_PRICE,
    regular_price: ROBUX_BUNDLE_PRICE,
    asset_id: '140291726071649',
    catalog_url: 'https://www.roblox.com/catalog/140291726071649/ii-Engine-Pro-ii-Tracker-Weekend',
    starts_at: '',
    ends_at: '',
    next_starts_at: '',
    hint: 'Want a discount? Engine + Tracker drops to 2,700 R$ every weekend (Fri 4 PM – Sun midnight ET). You can buy the sale item early and claim when the window opens.',
  };
}

const rows: FeatureRow[] = [
  {
    name: 'Direct menu connection',
    detail:
      'Engine links to ii Reborn Menu on its own. Pro gets special in-menu features as they ship.',
    free: false,
    pro: true,
  },
  {
    name: 'All AI features',
    detail:
      'Home menu assistant, Community /ai iiGPT, Studio AI autocomplete and actions, and AI mod checks. One shared daily AI budget.',
    free: false,
    pro: 'Home · Community · Studio · mod check',
  },
  {
    name: 'ii SoundLab',
    detail:
      'Pro audio lab: Engine background playlist, upload into the ii Reborn Menu Sounds folder, enable/disable menu sounds, and edit bass, volume, speed, distortion, pitch, and reverb.',
    free: false,
    pro: true,
  },
  {
    name: 'Background music player',
    detail:
      'Quiet Home background music and playlist controls. Pro only. Managed from Home widgets and ii SoundLab.',
    free: false,
    pro: true,
  },
  {
    name: 'Self Tracker (share presence)',
    detail:
      'Pro can opt in so the menu publishes your nick and room to the Engine player list while Gorilla Tag is open.',
    free: false,
    pro: true,
  },
  {
    name: 'Customize tab',
    detail: 'Brand, themes, layouts, Home backgrounds, motion, and more.',
    free: false,
    pro: true,
  },
  {
    name: 'ii Studio Pro window',
    detail: 'Open Studio in its own always-focused desktop window with Pro chrome.',
    free: false,
    pro: true,
  },
  {
    name: 'Beta engine access',
    detail: 'Engine Beta releases and beta-gated surfaces stay Pro-only.',
    free: false,
    pro: true,
  },
  {
    name: 'Pro lounge chat (#pro-lounge)',
    detail: 'Private Community channel for Engine Pro members only.',
    free: false,
    pro: true,
  },
  {
    name: 'ii Tracker',
    detail:
      'Separate product, not built into Engine. Solo pre-order is $20 on iistupid.com. The $25 site pack or 3,250 Robux catalog bundle is Engine Pro + ii Tracker. Different from Self Tracker (the in-Engine player list).',
    free: false,
    pro: 'Site · $20 solo / $25 pack · or 3,250 R$ bundle',
  },
  {
    name: 'Discord Pro giveaways',
    detail:
      'Occasional Discord drops for Engine Pro: unbanned Gorilla Tag accounts, in-game currency, and similar when we run them.',
    free: false,
    pro: true,
  },
  {
    name: 'Priority support queue',
    detail: 'Pro members get prioritized help when something breaks.',
    free: false,
    pro: true,
  },
  {
    name: 'Pro badge + chat flair',
    detail: 'Show Pro status on your account card and in Community chat.',
    free: false,
    pro: true,
  },
  {
    name: 'Core engine (launch, health, backups)',
    detail: 'Sign in, launch Gorilla Tag, Health & Repair, and Backups work on both plans.',
    free: true,
    pro: true,
  },
  {
    name: 'Trusted mods from the library',
    detail: 'Install verified plugins from the Trusted catalog. Unlimited on both plans.',
    free: 'Unlimited',
    pro: 'Unlimited',
  },
  {
    name: 'Community chat & announcements',
    detail: 'Discord-style Community tab with announcement channels and member chat.',
    free: true,
    pro: true,
  },
  {
    name: 'Player list (view)',
    detail:
      'See opted-in Engine players and their shared room codes. Viewing is open to Free and Pro.',
    free: true,
    pro: true,
  },
  {
    name: 'ii Studio access',
    detail:
      'Open the built-in C# workspace on Free and Pro. Project sources and Pro window differ by plan.',
    free: true,
    pro: true,
  },
  {
    name: 'ii Studio project sources',
    detail:
      'Free starts from ii Template v2 or ii Reborn Menu only. Pro adds GitHub clones and ZIP import.',
    free: 'Template v2 + ii Reborn Menu',
    pro: 'GitHub + ZIP import',
  },
  {
    name: 'Studio editor polish',
    detail: 'Smooth caret, word wrap toggle, font size controls, minimap, and sticky scroll.',
    free: 'Basic editor',
    pro: 'Smooth caret + minimap + wrap',
  },
  {
    name: 'Studio AI autocomplete',
    detail:
      'Optional AI completions in Studio when enabled under Settings. Uses the shared daily AI allowance.',
    free: 'Settings toggle',
    pro: 'Settings toggle',
  },
  {
    name: 'Custom app name & tagline',
    detail: 'Change the sidebar name and tagline.',
    free: false,
    pro: true,
  },
  {
    name: 'Custom icon (sidebar + window)',
    detail: 'Import a PNG/JPG/WebP icon for the sidebar and Windows taskbar/window icon.',
    free: false,
    pro: true,
  },
  {
    name: 'App themes',
    detail: 'Switch between Gray and Warm.',
    free: 'Gray only',
    pro: 'Gray and Warm',
  },
  {
    name: 'App layouts',
    detail: 'Classic, Wide, or Focus shell layouts. Navigation stays the same.',
    free: false,
    pro: 'Classic / Wide / Focus',
  },
  {
    name: 'Home photo backgrounds',
    detail: 'Full-screen photos behind Home with optional blur. Not inside the launch card.',
    free: false,
    pro: true,
  },
  {
    name: 'Startup animations',
    detail: 'Choose Cone, Warm, Flash, or Simple intro scenes and intro length.',
    free: 'Default only',
    pro: 'Cone, Warm, Flash, Simple',
  },
  {
    name: 'Grid page switcher',
    detail:
      'In Customize: squares cover the screen, then open on the next page. Fast, Normal, or Slow.',
    free: false,
    pro: 'Fast / Normal / Slow',
  },
  {
    name: 'Background pattern',
    detail: 'Light grid or dots behind the app that brighten near the cursor. Toggle in Customize.',
    free: false,
    pro: true,
  },
  {
    name: 'Density and corners',
    detail: 'Comfortable or compact density, rounded or sharp corners, and wallpaper glow options.',
    free: false,
    pro: true,
  },
  {
    name: 'Import / export Customize presets',
    detail: 'Save and share Customize presets as JSON.',
    free: false,
    pro: true,
  },
  {
    name: 'Flexible Home card layout',
    detail:
      'Drag cards between Under launch, Right side, and Bottom row. Resize cards to share a row.',
    free: false,
    pro: true,
  },
];

function Cell({ value }: { value: boolean | string }) {
  if (value === true) {
    return (
      <span className="plans-yes" aria-label="Included">
        <Check size={16} />
      </span>
    );
  }
  if (value === false) {
    return (
      <span className="plans-no" aria-label="Not included">
        <Minus size={16} />
      </span>
    );
  }
  return <span className="plans-text">{value}</span>;
}

function demoRobloxStatus(): RobloxStatus {
  const weekend = demoWeekendSale();
  return {
    configured: true,
    catalog_url: ROBUX_CATALOG_URL,
    robux_price: ROBUX_PRICE,
    shop_url: SHOP_URL,
    product_name: 'ii Engine Pro Lifetime',
    linked: false,
    roblox_username: null,
    claimed: false,
    claimed_at: null,
    claimed_grants: [],
    bundle_asset_id: '112921567316975',
    bundle_catalog_url: ROBUX_BUNDLE_CATALOG_URL,
    bundle_robux_price: ROBUX_BUNDLE_PRICE,
    bundle_product_name: 'ii Engine Pro + ii Tracker — Lifetime',
    weekend_sale: weekend,
    weekend_claim_pending: false,
    owns_weekend_item: false,
    products: [
      {
        id: 'engine',
        asset_id: '93620103303755',
        catalog_url: ROBUX_CATALOG_URL,
        robux_price: ROBUX_PRICE,
        product_name: 'ii Engine Pro — Lifetime',
        grants: ['pro'],
      },
      {
        id: 'bundle',
        asset_id: '112921567316975',
        catalog_url: ROBUX_BUNDLE_CATALOG_URL,
        robux_price: ROBUX_BUNDLE_PRICE,
        product_name: 'ii Engine Pro + ii Tracker — Lifetime',
        grants: ['pro', 'ii_tracker'],
      },
    ],
  };
}

export default function Plans({
  demo = false,
  isPro = false,
  demoPricing,
  onOpenTracker,
  onMembershipRefresh,
}: {
  demo?: boolean;
  isPro?: boolean;
  demoPricing?: Partial<PlansPricing>;
  onOpenTracker?: () => void;
  onMembershipRefresh?: () => void | Promise<void>;
}) {
  const [view, setView] = useState<'overview' | 'robux'>('overview');
  const [robuxProduct, setRobuxProduct] = useState<'engine' | 'bundle'>('engine');
  const [open, setOpen] = useState<string | null>(rows[0]?.name ?? null);
  const [roblox, setRoblox] = useState<RobloxStatus | null>(null);
  const [pricing, setPricing] = useState<PlansPricing>({
    ...defaultPricing,
    ...demoPricing,
  });
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function refreshRoblox() {
    if (demo) {
      setRoblox((current) => current ?? demoRobloxStatus());
      return;
    }
    const response = await apiRequest('/v1/billing/roblox/status');
    setRoblox((await response.json()) as RobloxStatus);
  }

  async function refreshPricing() {
    if (demoPricing) {
      setPricing({ ...defaultPricing, ...demoPricing });
      return;
    }
    try {
      const response = await apiRequest('/v1/platform/operations');
      const payload = (await response.json()) as { pricing?: Partial<PlansPricing> };
      setPricing({ ...defaultPricing, ...(payload.pricing ?? {}) });
    } catch {
      if (demo) setPricing(defaultPricing);
    }
  }

  useEffect(() => {
    void refreshRoblox().catch((reason) => {
      setError(errorMessage(reason, 'Could not load Roblox billing.'));
    });
    void refreshPricing().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per demo/live mode
  }, [demo]);

  async function linkRoblox(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (demo) {
        setRoblox((current) => ({
          ...(current ?? demoRobloxStatus()),
          linked: true,
          roblox_username: username.trim() || 'DemoUser',
        }));
        setNotice('Demo Roblox account linked. Buy a catalog item, then claim.');
        return;
      }
      const response = await apiRequest(
        '/v1/billing/roblox/link',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username.trim() }),
          signal: AbortSignal.timeout(45_000),
        },
        true,
      );
      setRoblox((await response.json()) as RobloxStatus);
      setNotice('Roblox account linked. Buy a catalog item, then claim.');
    } catch (reason) {
      setError(errorMessage(reason, 'Could not link Roblox.'));
    } finally {
      setBusy(false);
    }
  }

  async function claimPro() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (demo) {
        const grants = robuxProduct === 'bundle' ? ['pro', 'ii_tracker'] : ['pro'];
        setRoblox((current) =>
          current
            ? {
                ...current,
                claimed: true,
                claimed_at: new Date().toISOString(),
                claimed_grants: grants,
              }
            : current,
        );
        setNotice(
          robuxProduct === 'bundle'
            ? 'Demo claim complete — Engine Pro + ii Tracker roles.'
            : 'Demo Pro claim complete.',
        );
        await onMembershipRefresh?.();
        return;
      }
      const response = await apiRequest('/v1/billing/roblox/claim', {
        method: 'POST',
        timeoutMs: 60_000,
      });
      const payload = (await response.json()) as RobloxStatus;
      setRoblox(payload);
      const grants = payload.claimed_grants || [];
      setNotice(
        grants.includes('ii_tracker')
          ? 'Claimed. Discord roles assigned: Engine Pro + ii Tracker.'
          : 'Engine Pro claimed. Discord role is assigned.',
      );
      try {
        await onMembershipRefresh?.();
      } catch {}
    } catch (reason) {
      setError(errorMessage(reason, 'Could not claim Robux purchase.'));
    } finally {
      setBusy(false);
    }
  }

  const weekend = roblox?.weekend_sale || demoWeekendSale();
  const weekendLive = !!weekend.active;
  const catalogUrl = roblox?.catalog_url || ROBUX_CATALOG_URL;
  const bundleCatalogUrl = roblox?.bundle_catalog_url || ROBUX_BUNDLE_CATALOG_URL;
  const lifetimeUsd = pricing.lifetime_usd || LIFETIME_PRICE_USD;
  const bundleUsd = pricing.bundle_usd || TRACKER_BUNDLE_PRICE_USD;
  const trackerSoloUsd = pricing.tracker_solo_usd || TRACKER_SOLO_PRICE_USD;
  const robuxPrice = pricing.robux_price || roblox?.robux_price || ROBUX_PRICE;
  const robuxBundlePrice =
    roblox?.bundle_robux_price ||
    pricing.bundle_robux_price ||
    (weekendLive ? ROBUX_WEEKEND_PRICE : ROBUX_BUNDLE_PRICE);
  const bundleWasPrice =
    roblox?.bundle_robux_was_price ??
    pricing.bundle_robux_was_price ??
    (weekendLive ? ROBUX_BUNDLE_PRICE : null);
  const lifetimeSale = pricing.lifetime_on_sale;
  const bundleSale = pricing.bundle_on_sale;
  const trackerSoloSale = pricing.tracker_solo_on_sale;
  const robuxSale = pricing.robux_on_sale || !!roblox?.robux_on_sale;
  const bundleRobuxManualSale =
    !weekendLive && (pricing.bundle_robux_on_sale || !!roblox?.bundle_robux_on_sale);
  const lifetimeSaleName = pricing.lifetime_sale_name.trim();
  const bundleSaleName = pricing.bundle_sale_name.trim();
  const trackerSoloSaleName = pricing.tracker_solo_sale_name.trim();
  const robuxSaleName = (pricing.robux_sale_name || roblox?.robux_sale_name || '').trim();
  const bundleRobuxSaleName = (
    pricing.bundle_robux_sale_name ||
    roblox?.bundle_robux_sale_name ||
    ''
  ).trim();
  const lifetimeWas = pricing.lifetime_was_usd;
  const bundleWas = pricing.bundle_was_usd;
  const trackerSoloWas = pricing.tracker_solo_was_usd;
  const robuxWas = pricing.robux_was_price ?? roblox?.robux_was_price ?? null;
  const activeCatalogUrl = robuxProduct === 'bundle' ? bundleCatalogUrl : catalogUrl;
  const claimedWithTracker = (roblox?.claimed_grants || []).includes('ii_tracker');

  if (view === 'robux') {
    return (
      <div className="plans-page plans-robux-page">
        <button type="button" className="plans-robux-back" onClick={() => setView('overview')}>
          <ArrowLeft size={16} /> Back to Plans
        </button>
        <PageHero
          className="plans-hero"
          title="Buy with Robux"
          subtitle={`${robuxPrice.toLocaleString()} R$ Engine Pro, or ${robuxBundlePrice.toLocaleString()} R$ Engine Pro + ii Tracker. Link your username once. Each Roblox account can redeem only once.`}
        />

        <section
          className={`panel plans-weekend-banner ${weekendLive ? 'is-live' : ''}`}
          aria-label="Weekend Robux deal"
        >
          <div>
            <strong>{weekendLive ? 'Weekend deal is live' : 'Weekend Robux deal'}</strong>
            <p>{weekend.hint}</p>
          </div>
          <div className="plans-weekend-price">
            {weekendLive ? (
              <>
                <span className="plans-price-was">{ROBUX_BUNDLE_PRICE.toLocaleString()} R$</span>
                <span>{ROBUX_WEEKEND_PRICE.toLocaleString()} R$</span>
              </>
            ) : (
              <span>
                {ROBUX_WEEKEND_PRICE.toLocaleString()} R$ · {weekend.window_label}
              </span>
            )}
          </div>
        </section>

        {roblox?.weekend_claim_pending ? (
          <p className="plans-roblox-notice" role="status">
            You already own the weekend bundle item. Claim opens {weekend.window_label}.
          </p>
        ) : null}

        <section className="panel plans-robux-steps-panel" aria-label="Robux purchase steps">
          <div className="plans-robux-products" role="tablist" aria-label="Robux catalog products">
            <button
              type="button"
              role="tab"
              aria-selected={robuxProduct === 'engine'}
              className={`plans-robux-product ${robuxProduct === 'engine' ? 'is-active' : ''}`}
              onClick={() => setRobuxProduct('engine')}
            >
              <strong>Engine Pro</strong>
              <span>{robuxPrice.toLocaleString()} R$</span>
              <small>Discord: ii Engine Pro</small>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={robuxProduct === 'bundle'}
              className={`plans-robux-product ${robuxProduct === 'bundle' ? 'is-active' : ''}`}
              onClick={() => setRobuxProduct('bundle')}
            >
              <strong>Engine + Tracker</strong>
              <span>{robuxBundlePrice.toLocaleString()} R$</span>
              <small>Discord: Pro + ii Tracker</small>
            </button>
          </div>

          <ol className="plans-robux-steps">
            <li className={roblox?.linked ? 'done' : ''}>
              <span>1</span>
              <div>
                <strong>Link your Roblox username</strong>
                <p>Use the exact account that will buy the catalog item.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Buy on Roblox Marketplace</strong>
                <p>
                  {robuxProduct === 'bundle'
                    ? `Open the ${robuxBundlePrice.toLocaleString()} R$ Engine + Tracker bundle and complete the purchase.`
                    : `Open the ${robuxPrice.toLocaleString()} R$ Engine Pro item and complete the purchase.`}
                </p>
              </div>
            </li>
            <li className={roblox?.claimed ? 'done' : ''}>
              <span>3</span>
              <div>
                <strong>Claim Discord roles</strong>
                <p>
                  We verify ownership and assign{' '}
                  {robuxProduct === 'bundle' ? 'ii Engine Pro + ii Tracker' : 'ii Engine Pro'}. That
                  username cannot redeem again.
                </p>
              </div>
            </li>
          </ol>

          {roblox?.claimed ? (
            <div className="plans-roblox-claimed-block">
              <p className="plans-roblox-claimed" role="status">
                <Check size={16} /> {claimedWithTracker ? 'Engine Pro + ii Tracker' : 'Engine Pro'}{' '}
                claimed for @{roblox.roblox_username}. This Roblox username is marked owned and
                cannot be redeemed again.
              </p>
              {!claimedWithTracker ? (
                <p className="plans-payment-hint">
                  Already on Pro? Buy the {robuxBundlePrice.toLocaleString()} R$ bundle on the same
                  Roblox account, then claim again to add ii Tracker.
                </p>
              ) : null}
              {!claimedWithTracker ? (
                <div className="plans-robux-actions">
                  <a
                    className="plans-purchase-link"
                    href={bundleCatalogUrl}
                    onClick={externalClick(bundleCatalogUrl)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open Tracker bundle &amp; buy
                    <ExternalLink size={16} />
                  </a>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => void claimPro()}
                  >
                    {busy ? <Loader2 size={16} className="spin" /> : null}
                    Claim ii Tracker upgrade
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <form className="plans-roblox-form" onSubmit={linkRoblox}>
                <label>
                  Roblox username or display name
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder={roblox?.roblox_username || 'YourRobloxName'}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={50}
                    disabled={busy}
                  />
                </label>
                <button type="submit" disabled={busy || username.trim().length < 3}>
                  {busy ? <Loader2 size={16} className="spin" /> : <Link2 size={16} />}
                  {roblox?.linked ? 'Update link' : 'Link Roblox'}
                </button>
              </form>
              <p className="plans-payment-hint">
                Paste the name from your Roblox profile (username or display name). We resolve it to
                the account that must buy the catalog item.
              </p>
              {roblox?.linked && (
                <p className="plans-payment-hint">
                  Linked as <strong>@{roblox.roblox_username}</strong>. Buy the selected catalog
                  item, then claim below.
                </p>
              )}
              <div className="plans-robux-actions">
                <a
                  className="plans-purchase-link"
                  href={activeCatalogUrl}
                  onClick={externalClick(activeCatalogUrl)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open catalog &amp; buy
                  <ExternalLink size={16} />
                </a>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !roblox?.linked}
                  onClick={() => void claimPro()}
                >
                  {busy ? <Loader2 size={16} className="spin" /> : null}
                  {robuxProduct === 'bundle' ? 'Claim Engine + Tracker' : 'Claim Engine Pro'}
                </button>
              </div>
            </>
          )}
          {notice && (
            <p className="plans-roblox-notice" role="status">
              {notice}
            </p>
          )}
          {notice && (roblox?.claimed_grants || []).includes('ii_tracker') && onOpenTracker ? (
            <button type="button" className="plans-purchase-link" onClick={onOpenTracker}>
              Open Player Tracker
            </button>
          ) : null}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="plans-page plans-page-chart">
      <PageHero
        className="plans-hero"
        title="Plans"
        subtitle={
          isPro
            ? 'Engine Pro is active on this account. Here is everything it covers.'
            : 'Get Engine Pro on iistupid.com or Robux — including a Tracker + Engine Robux bundle.'
        }
      />

      <section
        className={`panel plans-weekend-banner ${weekendLive ? 'is-live' : ''}`}
        aria-label="Weekend Robux deal"
      >
        <div>
          <strong>{weekendLive ? 'Weekend deal is live' : 'Save Robux on weekends'}</strong>
          <p>{weekend.hint}</p>
        </div>
        <button
          type="button"
          className="plans-purchase-link"
          onClick={() => {
            setRobuxProduct('bundle');
            setView('robux');
          }}
        >
          {weekendLive ? 'Claim weekend deal' : 'See Robux steps'}
        </button>
      </section>

      {isPro && (
        <section className="panel plans-owned-banner" aria-label="Your plan">
          <Crown size={18} aria-hidden="true" />
          <div>
            <strong>You&apos;re on Pro</strong>
            <p>
              Engine Pro is unlocked. ii Tracker is separate — buy the site pack or the{' '}
              {ROBUX_BUNDLE_PRICE.toLocaleString()} R$ Robux bundle, then claim.
            </p>
          </div>
          <div className="plans-owned-actions">
            <a
              className="plans-purchase-link"
              href={SHOP_HOME_URL}
              onClick={externalClick(SHOP_HOME_URL)}
              target="_blank"
              rel="noreferrer"
            >
              ii Tracker pre-order <ExternalLink size={14} />
            </a>
            <button
              type="button"
              className="plans-purchase-link"
              onClick={() => {
                setRobuxProduct('bundle');
                setView('robux');
              }}
            >
              Claim Tracker via Robux
            </button>
          </div>
        </section>
      )}

      {!isPro && (
        <section className="plans-tier-grid" aria-label="Engine Pro plans">
          <article className="plans-tier-card">
            <span className="plans-tier-kicker">
              <ShoppingBag size={14} /> Website
            </span>
            <strong className="plans-tier-price">${MONTHLY_PRICE_USD}</strong>
            <h3>Monthly</h3>
            <p>$7 / month Engine Pro. Card checkout on iistupid.com.</p>
            <a
              className="plans-purchase-link"
              href={SHOP_URL}
              onClick={externalClick(SHOP_URL)}
              target="_blank"
              rel="noreferrer"
            >
              Buy monthly <ExternalLink size={14} />
            </a>
          </article>

          <article className="plans-tier-card plans-tier-card-featured">
            <span className="plans-tier-badge">Popular</span>
            <span className="plans-tier-kicker">
              <ShoppingBag size={14} /> Website
            </span>
            <strong className="plans-tier-price">
              {lifetimeSale && lifetimeWas != null && lifetimeWas > lifetimeUsd ? (
                <span className="plans-price-was">${lifetimeWas}</span>
              ) : null}
              ${lifetimeUsd}
            </strong>
            {lifetimeSale && lifetimeSaleName ? (
              <p className="plans-sale-line">{lifetimeSaleName}</p>
            ) : null}
            <h3>Lifetime</h3>
            <p>
              ${lifetimeUsd} one-time Engine Pro. Card checkout on the site. Pro is assigned after
              purchase.
            </p>
            <a
              className="plans-purchase-link plans-purchase-link-primary"
              href={SHOP_URL}
              onClick={externalClick(SHOP_URL)}
              target="_blank"
              rel="noreferrer"
            >
              Buy lifetime <ExternalLink size={14} />
            </a>
          </article>

          <article className="plans-tier-card plans-tier-card-bundle">
            <span className="plans-tier-kicker">
              <Radar size={14} /> Website only
            </span>
            <strong className="plans-tier-price">
              {bundleSale && bundleWas != null && bundleWas > bundleUsd ? (
                <span className="plans-price-was">${bundleWas}</span>
              ) : null}
              ${bundleUsd}
            </strong>
            {bundleSale && bundleSaleName ? (
              <p className="plans-sale-line">{bundleSaleName}</p>
            ) : null}
            <h3>Lifetime + ii Tracker</h3>
            <p>
              ${bundleUsd}: Engine Pro now, plus ii Tracker (separate product, not built into
              Engine). You can also buy ii Tracker by itself as a ${trackerSoloUsd} pre-order on the
              site.
            </p>
            <a
              className="plans-purchase-link"
              href={SHOP_HOME_URL}
              onClick={externalClick(SHOP_HOME_URL)}
              target="_blank"
              rel="noreferrer"
            >
              View on iistupid.com <ExternalLink size={14} />
            </a>
          </article>

          <article className="plans-tier-card">
            <span className="plans-tier-kicker">
              <Radar size={14} /> Website only
            </span>
            <strong className="plans-tier-price">
              {trackerSoloSale && trackerSoloWas != null && trackerSoloWas > trackerSoloUsd ? (
                <span className="plans-price-was">${trackerSoloWas}</span>
              ) : null}
              ${trackerSoloUsd}
            </strong>
            {trackerSoloSale && trackerSoloSaleName ? (
              <p className="plans-sale-line">{trackerSoloSaleName}</p>
            ) : null}
            <h3>ii Tracker solo</h3>
            <p>
              ${trackerSoloUsd} Tracker-only pre-order on the site. Does not include Engine Pro.
            </p>
            <a
              className="plans-purchase-link"
              href={SHOP_HOME_URL}
              onClick={externalClick(SHOP_HOME_URL)}
              target="_blank"
              rel="noreferrer"
            >
              Tracker pre-order <ExternalLink size={14} />
            </a>
          </article>

          <article className="plans-tier-card">
            <span className="plans-tier-kicker">
              <Shirt size={14} /> Roblox
            </span>
            <strong className="plans-tier-price">
              {robuxSale && robuxWas != null && robuxWas > robuxPrice ? (
                <span className="plans-price-was">{robuxWas.toLocaleString()} R$</span>
              ) : null}
              {robuxPrice.toLocaleString()} R$
            </strong>
            {robuxSale && robuxSaleName ? <p className="plans-sale-line">{robuxSaleName}</p> : null}
            <h3>Lifetime (Robux)</h3>
            <p>
              {robuxPrice.toLocaleString()} Robux lifetime Engine Pro. Optional path for all ages.
              Claim on a dedicated page.
            </p>
            <button
              type="button"
              className="plans-purchase-link"
              onClick={() => {
                setRobuxProduct('engine');
                setView('robux');
              }}
            >
              Robux purchase steps
            </button>
          </article>

          <article className="plans-tier-card plans-tier-card-bundle">
            <span className="plans-tier-kicker">
              <Shirt size={14} /> Roblox bundle
            </span>
            <strong className="plans-tier-price">
              {bundleWasPrice != null && bundleWasPrice > robuxBundlePrice ? (
                <span className="plans-price-was">{bundleWasPrice.toLocaleString()} R$</span>
              ) : null}
              {robuxBundlePrice.toLocaleString()} R$
            </strong>
            {weekendLive ? (
              <p className="plans-sale-line">Weekend deal</p>
            ) : bundleRobuxManualSale && bundleRobuxSaleName ? (
              <p className="plans-sale-line">{bundleRobuxSaleName}</p>
            ) : null}
            <h3>Lifetime + ii Tracker (Robux)</h3>
            <p>
              {robuxBundlePrice.toLocaleString()} Robux for Engine Pro and ii Tracker together
              {weekendLive
                ? ' (weekend sale price through Sunday midnight ET)'
                : ` — drops to ${ROBUX_WEEKEND_PRICE.toLocaleString()} R$ every weekend`}
              . Grants both Discord roles after claim.
            </p>
            <button
              type="button"
              className="plans-purchase-link"
              onClick={() => {
                setRobuxProduct('bundle');
                setView('robux');
              }}
            >
              Bundle purchase steps
            </button>
          </article>
        </section>
      )}

      <section className="panel plans-pro-spotlight" aria-label="Best Pro features">
        <div className="plans-pro-spotlight-head">
          <h2>{isPro ? 'What your Pro covers' : 'What Pro unlocks'}</h2>
          <p>{isPro ? 'Active on this account.' : 'Included with every purchase above.'}</p>
        </div>
        <ul className="plans-pro-spotlight-grid">
          {PRO_SPOTLIGHT.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.name}>
                <div className="plans-pro-spotlight-pill">
                  <Icon size={15} aria-hidden="true" />
                  <span>{item.name}</span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="panel plans-chart-panel">
        <div className="section-heading-row">
          <div>
            <h2>Free vs Pro</h2>
            <p>Pro features listed first. Open a row for details.</p>
          </div>
        </div>
        <div className="plans-table-wrap">
          <table className="plans-table plans-table-expandable">
            <thead>
              <tr>
                <th scope="col">Feature</th>
                <th scope="col">Free</th>
                <th scope="col">Pro</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const expanded = open === row.name;
                return (
                  <tr key={row.name} className={expanded ? 'expanded' : ''}>
                    <th scope="row">
                      <button
                        type="button"
                        className="plans-feature-toggle"
                        aria-expanded={expanded}
                        onClick={() => setOpen(expanded ? null : row.name)}
                      >
                        <span>
                          <strong>{row.name}</strong>
                          {expanded ? <small>{row.detail}</small> : null}
                        </span>
                        <ChevronDown size={16} className={expanded ? 'open' : ''} />
                      </button>
                    </th>
                    <td>
                      <Cell value={row.free} />
                    </td>
                    <td>
                      <Cell value={row.pro} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="plans-footnote">
          {'Pro includes Self Tracker, Customize, Studio Pro, #pro-lounge, Discord giveaways, and priority support. Viewing the player list stays free. ii Tracker is a separate product: $' +
            trackerSoloUsd +
            ' individual pre-order on the site, the $' +
            bundleUsd +
            ' Pro + ii Tracker site pack, or the ' +
            robuxBundlePrice.toLocaleString() +
            ' R$ Robux bundle.'}
        </p>
      </section>
    </div>
  );
}
