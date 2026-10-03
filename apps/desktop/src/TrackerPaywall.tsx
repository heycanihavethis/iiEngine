import { ExternalLink, Lock, Radar, Shirt, ShoppingBag } from 'lucide-react';
import { externalClick } from './external';
import type { Page } from './store';

const SHOP_HOME_URL = 'https://iistupid.com/';
const ROBUX_BUNDLE_CATALOG_URL =
  'https://www.roblox.com/catalog/140291726071649/ii-Engine-Pro-ii-Tracker-Lifetime';

const FAKE_ROWS = [
  { name: '••••••', meta: 'Forest · US-E', tag: 'rare' },
  { name: '••••••', meta: 'Canyon · EU', tag: 'live' },
  { name: '••••••', meta: 'Mines · US-W', tag: 'live' },
  { name: '••••••', meta: 'City · AU', tag: 'rare' },
  { name: '••••••', meta: 'Beach · US-E', tag: 'live' },
  { name: '••••••', meta: 'Mountain · EU', tag: 'live' },
] as const;

type TrackerPaywallProps = {
  product: 'player' | 'target' | 'scout';
  navigate?: (page: Page) => void;
};

const COPY: Record<
  TrackerPaywallProps['product'],
  { title: string; body: string; previewLabel: string }
> = {
  player: {
    title: 'Player Tracker',
    body: 'Live lobby players and rare cosmetics from public rooms. Included with ii Tracker — separate from Engine Pro.',
    previewLabel: 'Live board preview',
  },
  target: {
    title: 'Target Tracker',
    body: 'Watch specific players and get notified when they show up. Part of the ii Tracker product (beta).',
    previewLabel: 'Watchlist preview',
  },
  scout: {
    title: 'Tracker Scout',
    body: 'Ask natural-language questions across recent sightings. Tracker Scout is included with ii Tracker.',
    previewLabel: 'Scout preview',
  },
};

export function TrackerPaywall({ product, navigate }: TrackerPaywallProps) {
  const copy = COPY[product];
  return (
    <div className="tracker-paywall" data-product={product}>
      <div className="tracker-paywall-tease" aria-hidden="true">
        <div className="tracker-paywall-tease-glow" />
        <header className="tracker-paywall-tease-head">
          <strong>{copy.title}</strong>
          <span>{copy.previewLabel}</span>
        </header>
        {product === 'scout' ? (
          <div className="tracker-paywall-scout-fake">
            <div className="tracker-paywall-scout-ring" />
            <p>Who was in Forest an hour ago?</p>
          </div>
        ) : (
          <ul className="tracker-paywall-fake-grid">
            {FAKE_ROWS.map((row, index) => (
              <li key={`${row.meta}-${index}`} className={`is-${row.tag}`}>
                <span className="tracker-paywall-avatar" />
                <div>
                  <strong>{row.name}</strong>
                  <small>{row.meta}</small>
                </div>
                <em>{row.tag}</em>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="tracker-paywall-veil" aria-hidden="true" />

      <div
        className="tracker-paywall-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tracker-paywall-title"
      >
        <span className="tracker-paywall-lock">
          <Lock size={16} aria-hidden="true" />
          ii Tracker required
        </span>
        <h2 id="tracker-paywall-title">{copy.title}</h2>
        <p>{copy.body}</p>
        <div className="tracker-paywall-actions">
          <button
            type="button"
            className="primary tracker-paywall-primary"
            onClick={() => navigate?.('Plans')}
          >
            <Radar size={16} aria-hidden="true" />
            View Plans
          </button>
          <a
            className="tracker-paywall-secondary"
            href={SHOP_HOME_URL}
            target="_blank"
            rel="noreferrer"
            onClick={externalClick(SHOP_HOME_URL)}
          >
            <ShoppingBag size={15} aria-hidden="true" />
            Tracker on iistupid.com
            <ExternalLink size={13} aria-hidden="true" />
          </a>
          <a
            className="tracker-paywall-secondary"
            href={ROBUX_BUNDLE_CATALOG_URL}
            target="_blank"
            rel="noreferrer"
            onClick={externalClick(ROBUX_BUNDLE_CATALOG_URL)}
          >
            <Shirt size={15} aria-hidden="true" />
            Pro + Tracker (Robux)
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        </div>
      </div>
    </div>
  );
}
