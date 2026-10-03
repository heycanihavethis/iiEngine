import { useEffect, useMemo, useState } from 'react';
import { Bot, Code2, Lock, Search, Sparkles, X } from 'lucide-react';
import { ApiError, apiRequest, errorMessage } from './api';
import { queueCatalogSourceIntent } from './catalogStudioBridge';
import PageHero from './PageHero';
import { trackFeature } from './telemetry';
import bundledMenuCatalog from './assets/menu-catalog.json';

type CatalogItem = {
  id: string;
  name: string;
  description: string;
  action: boolean;
};

type CatalogCategory = {
  id: string;
  name: string;
  count: number;
  items: CatalogItem[];
};

type CatalogPayload = {
  version?: string;
  total: number;
  categories: CatalogCategory[];
};

type ExplainPayload = {
  name: string;
  category?: string;
  answer: string;
  disclaimer: string;
};

const DEMO_CATALOG: CatalogPayload = {
  version: 'demo',
  total: 6,
  categories: [
    {
      id: 'important-mods',
      name: 'Important Mods',
      count: 2,
      items: [
        {
          id: 'anti-afk',
          name: 'Anti AFK',
          description: "Doesn't let you get kicked for being AFK.",
          action: false,
        },
        {
          id: 'discord-rpc',
          name: 'Discord RPC',
          description: 'Shows your Gorilla Tag status on Discord.',
          action: false,
        },
      ],
    },
    {
      id: 'movement-mods',
      name: 'Movement Mods',
      count: 2,
      items: [
        {
          id: 'platforms',
          name: 'Platforms',
          description: 'Spawns platforms on your hands when holding grip.',
          action: false,
        },
        {
          id: 'iron-man',
          name: 'Iron Man',
          description: 'Turns you into iron man, rotate your hands around to change direction.',
          action: false,
        },
      ],
    },
    {
      id: 'visual-mods',
      name: 'Visual Mods',
      count: 2,
      items: [
        {
          id: 'name-tags',
          name: 'Name Tags',
          description: 'Gives players name tags above their heads that show their nickname.',
          action: false,
        },
        {
          id: 'casual-box-esp',
          name: 'Casual Box ESP',
          description: 'Puts boxes over players. Shows everyone.',
          action: false,
        },
      ],
    },
  ],
};

const CATEGORY_PREF = [
  'important-mods',
  'movement-mods',
  'advantage-mods',
  'visual-mods',
  'fun-mods',
  'safety-mods',
  'sound-mods',
  'projectile-mods',
  'room-mods',
  'master-mods',
];

const EXIT_RE = /^Exit\s+/i;
const VARIANT_RE = /^(?:\d+\s*FPS|Auto Join Room\s+".+"|Load Custom Preset\s+\d+)$/i;
const INTERNAL_RE = /^(?:[A-Z][a-z]+(?:[A-Z][a-zA-Z0-9]+)+|[a-z]+[A-Z][a-zA-Z0-9]*|.+_)$/;

function itemTier(item: CatalogItem): number {
  if (EXIT_RE.test(item.name)) return 6;
  if (VARIANT_RE.test(item.name)) return 4;
  if (INTERNAL_RE.test(item.name) || (/[a-z][A-Z]/.test(item.name) && !item.name.includes(' '))) {
    return 3;
  }
  if (item.action) return 1;
  return 0;
}

function sortCatalogItems(items: CatalogItem[]): CatalogItem[] {
  return [...items]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const tier = itemTier(a.item) - itemTier(b.item);
      return tier !== 0 ? tier : a.index - b.index;
    })
    .map(({ item }) => item);
}

function normalizeCatalog(data: CatalogPayload): CatalogPayload {
  const categories = (Array.isArray(data.categories) ? data.categories : [])
    .map((category) => {
      const seen = new Set<string>();
      const items = sortCatalogItems(
        (category.items || []).filter((item) => {
          const key = (item.name || '').trim().toLowerCase();
          if (!key || seen.has(key)) return false;
          if (/^Auto Join Room\s+".+"$/i.test(item.name)) return false;
          seen.add(key);
          return true;
        }),
      );
      return {
        ...category,
        items,
        count: items.length,
      };
    })
    .filter((category) => category.items.length > 0);

  categories.sort((a, b) => {
    const ai = CATEGORY_PREF.indexOf(a.id);
    const bi = CATEGORY_PREF.indexOf(b.id);
    if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  return {
    version: data.version,
    total: categories.reduce((sum, category) => sum + category.items.length, 0),
    categories,
  };
}

function defaultCategoryId(categories: CatalogCategory[]): string {
  for (const id of CATEGORY_PREF) {
    if (categories.some((category) => category.id === id)) return id;
  }
  return categories[0]?.id || 'all';
}

export default function Catalog({
  demo,
  isPro = false,
  onUpgrade,
  onOpenSource,
}: {
  demo: boolean;
  isPro?: boolean;
  onUpgrade?: () => void;
  onOpenSource?: () => void;
}) {
  const [payload, setPayload] = useState<CatalogPayload | null>(
    demo ? normalizeCatalog(DEMO_CATALOG) : null,
  );
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState(
    demo ? defaultCategoryId(DEMO_CATALOG.categories) : 'important-mods',
  );
  const [barOpen, setBarOpen] = useState(false);
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [explain, setExplain] = useState<ExplainPayload | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    trackFeature('catalog', 'open');
    if (demo) return;
    let cancelled = false;
    const applyCatalog = (data: CatalogPayload, offlineNote = '') => {
      const next = normalizeCatalog({
        version: data.version,
        total: Number(data.total) || 0,
        categories: Array.isArray(data.categories) ? data.categories : [],
      });
      setPayload(next);
      setActiveCategory((current) =>
        next.categories.some((category) => category.id === current)
          ? current
          : defaultCategoryId(next.categories),
      );
      setError(offlineNote);
    };
    void (async () => {
      try {
        const response = await apiRequest('/v1/ai/menu-catalog');
        if (cancelled) return;
        applyCatalog((await response.json()) as CatalogPayload);
      } catch (reason) {
        if (cancelled) return;
        const fallback = bundledMenuCatalog as CatalogPayload;
        if (Array.isArray(fallback?.categories) && fallback.categories.length) {
          const staleApi =
            reason instanceof ApiError &&
            (reason.status === 404 ||
              /could not find \/v1\/ai\/menu-catalog/i.test(reason.message));
          applyCatalog(
            fallback,
            staleApi
              ? 'Showing the bundled menu catalog. Live API catalog is unavailable on this backend build.'
              : 'Showing the bundled menu catalog. Could not refresh from the server.',
          );
          return;
        }
        setError(errorMessage(reason, 'Could not load the menu catalog.'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo]);

  const term = search.trim().toLowerCase();
  const categories = useMemo(() => payload?.categories ?? [], [payload?.categories]);
  const activeLabel =
    activeCategory === 'all'
      ? 'All categories'
      : (categories.find((category) => category.id === activeCategory)?.name ?? 'Category');

  const visible = useMemo(() => {
    const scoped = term ? 'all' : activeCategory;
    return categories
      .map((category) => {
        if (scoped !== 'all' && category.id !== scoped) {
          return { ...category, items: [] as CatalogItem[] };
        }
        const items = category.items.filter((item) => {
          if (!term) return true;
          return `${item.name} ${item.description} ${category.name}`.toLowerCase().includes(term);
        });
        return { ...category, items, count: items.length };
      })
      .filter((category) => category.items.length > 0);
  }, [categories, activeCategory, term]);

  const visibleCount = visible.reduce((sum, category) => sum + category.items.length, 0);
  const flatItems = useMemo(
    () =>
      visible.flatMap((category) =>
        category.items.map((item) => ({
          item,
          categoryName: category.name,
          categoryId: category.id,
        })),
      ),
    [visible],
  );

  function selectItem(item: CatalogItem, categoryName: string) {
    setSelected(item);
    setSelectedCategory(categoryName);
    trackFeature('catalog', 'select');
  }

  async function askAi(item: CatalogItem, categoryName: string) {
    if (!isPro) {
      onUpgrade?.();
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (demo) {
        setExplain({
          name: item.name,
          category: categoryName,
          answer: [
            '**What it is**',
            `${item.name} is a demo catalog entry from ii Reborn Menu.`,
            '**What it does**',
            `- ${item.description || 'See the in-menu tooltip for details.'}`,
            '**Where to find it**',
            `- ${categoryName || 'Menu catalog'}`,
            '**Notes**',
            `- ${item.action ? 'Action — fires once when clicked.' : 'Toggle — stays on until disabled.'}`,
            '**Footnote**',
            'AI explanations can be wrong and are not perfect. This is informational only — not a safety rating.',
          ].join('\n'),
          disclaimer:
            'AI explanations can be wrong and are not perfect. This is informational only — not a safety rating.',
        });
        trackFeature('catalog', 'ask_ai_demo');
        return;
      }
      const response = await apiRequest('/v1/ai/catalog-explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: item.name, share_telemetry: false }),
        signal: AbortSignal.timeout(60_000),
      });
      setExplain((await response.json()) as ExplainPayload);
      trackFeature('catalog', 'ask_ai');
    } catch (reason) {
      setError(errorMessage(reason, 'Could not explain this mod right now.'));
    } finally {
      setBusy(false);
    }
  }

  function viewSource(item: CatalogItem, categoryName: string) {
    queueCatalogSourceIntent(item.name, categoryName);
    trackFeature('catalog', 'view_source');
    onOpenSource?.();
  }

  return (
    <section className="catalog-page">
      <PageHero
        compact
        kicker="II REBORN MENU"
        title="Catalog"
        subtitle="Every mod, sorted by category. Pick one to ask AI or jump to its source in Studio."
      />

      <div
        className={`catalog-catbar ${barOpen ? 'open' : ''}`}
        onMouseEnter={() => setBarOpen(true)}
        onMouseLeave={() => setBarOpen(false)}
      >
        <div className="catalog-catbar-handle" aria-hidden="true">
          <span>Categories</span>
          <strong>{activeLabel}</strong>
          <em>{payload?.total ?? 0} options</em>
        </div>
        <div className="catalog-catbar-panel" role="navigation" aria-label="Catalog categories">
          <button
            type="button"
            className={activeCategory === 'all' ? 'active' : ''}
            onClick={() => setActiveCategory('all')}
          >
            All <small>{payload?.total ?? 0}</small>
          </button>
          {categories.map((category) => (
            <button
              type="button"
              key={category.id}
              className={activeCategory === category.id ? 'active' : ''}
              onClick={() => setActiveCategory(category.id)}
            >
              {category.name} <small>{category.count}</small>
            </button>
          ))}
        </div>
      </div>

      <div className="catalog-toolbar">
        <label className="catalog-search">
          <Search size={16} />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search mods, settings, or keywords…"
            aria-label="Search catalog"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} aria-label="Clear search">
              <X size={14} />
            </button>
          )}
        </label>
        <p className="catalog-count">
          {visibleCount} {visibleCount === 1 ? 'result' : 'results'}
          {term ? ' matching' : ''}
          {activeCategory !== 'all' ? ` · ${activeLabel}` : ''}
        </p>
      </div>

      {(error || (!payload && !demo)) && (
        <div className={`operation-banner ${error && !payload ? 'error' : ''}`} role="status">
          {error || 'Loading menu catalog…'}
        </div>
      )}

      <div className="catalog-results" aria-live="polite">
        {activeCategory !== 'all' && visible[0] && (
          <header className="catalog-group-head">
            <div>
              <h3>{visible[0].name}</h3>
              <p className="catalog-group-sub">
                Gameplay options first. Actions and back buttons stay at the end.
              </p>
            </div>
            <small>{visible[0].count}</small>
          </header>
        )}
        <div className="catalog-grid">
          {flatItems.map(({ item, categoryName, categoryId }) => {
            const active = selected?.id === item.id && selectedCategory === categoryName;
            const kind = EXIT_RE.test(item.name) ? 'Back' : item.action ? 'Action' : 'Toggle';
            return (
              <article
                key={`${categoryId}-${item.id}`}
                className={`catalog-card ${active ? 'selected' : ''}`}
              >
                <button
                  type="button"
                  className="catalog-card-main"
                  onClick={() => selectItem(item, categoryName)}
                  aria-pressed={active}
                >
                  <span className="catalog-card-title">
                    {item.name}
                    <em data-kind={kind.toLowerCase()}>{kind}</em>
                  </span>
                  {activeCategory === 'all' && (
                    <span className="catalog-card-category">{categoryName}</span>
                  )}
                  <span className="catalog-card-desc">
                    {item.description || 'No description in the menu dump.'}
                  </span>
                </button>
                {active && (
                  <div className="catalog-card-actions">
                    {isPro ? (
                      <button
                        type="button"
                        className="primary catalog-card-ask"
                        disabled={busy}
                        onClick={() => void askAi(item, categoryName)}
                      >
                        <Sparkles size={14} />
                        {busy ? 'Asking…' : `Ask AI about ${item.name}`}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="catalog-card-ask locked"
                        onClick={() => onUpgrade?.()}
                      >
                        <Lock size={14} /> Engine Pro · Ask AI
                      </button>
                    )}
                    <button
                      type="button"
                      className="catalog-card-source"
                      onClick={() => viewSource(item, categoryName)}
                    >
                      <Code2 size={14} /> Jump to code
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
        {!flatItems.length && payload && <p className="empty-row">No mods match that search.</p>}
      </div>

      {explain && (
        <div
          className="catalog-ai-panel"
          role="dialog"
          aria-label={`AI explanation for ${explain.name}`}
          onClick={() => setExplain(null)}
        >
          <div className="catalog-ai-panel-inner">
            <header>
              <span className="eyebrow">
                <Bot size={14} /> AI EXPLAIN
              </span>
              <h3>{explain.name}</h3>
              <p className="disclaimer" role="note">
                {explain.disclaimer}
              </p>
              <p className="catalog-ai-dismiss">Click anywhere on this panel to dismiss</p>
            </header>
            <pre className="catalog-explain-body">{explain.answer}</pre>
          </div>
        </div>
      )}
    </section>
  );
}
