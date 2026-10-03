import type { CSSProperties } from 'react';

export type ThemeId = 'default' | 'ember';

export type OpeningScene = 'cone' | 'ember' | 'minimal' | 'pulse';

export type HomeBackgroundId =
  'none' | 'mountain' | 'mines' | 'campfire' | 'caves' | 'canyon' | 'cat';

export type HomeWidgetId =
  | 'announcements'
  | 'quickActions'
  | 'account'
  | 'managed'
  | 'assistant'
  | 'modChecker'
  | 'music'
  | 'health'
  | 'community'
  | 'studio'
  | 'backups'
  | 'weeklyPicks'
  | 'loadouts'
  | 'tracker';

export type HomeTrackerMode = 'lastPlayer' | 'lastRare' | 'targets';

export type HomeWidgetZone = 'main' | 'rail' | 'below';

export type HomeWidgetSize = 'regular' | 'compact';

export type LaunchHeroSize = 'regular' | 'compact';

export type HomeWidget = {
  id: HomeWidgetId;
  visible: boolean;
  zone: HomeWidgetZone;
  size: HomeWidgetSize;
};

export type ThemePalette = {
  orange: string;
  accent: string;
  focus: string;
  burnt: string;
  brown: string;
  shellA: string;
  shellB: string;
  sidebarA: string;
  sidebarB: string;
  panel: string;
  panelSoft: string;
  text: string;
  muted: string;
  line: string;
  scrollA: string;
  scrollB: string;
  scrollTrack: string;
  inputBg: string;
  inputBorder: string;
  inputText: string;
};

export type AppLayoutId = 'classic' | 'wide' | 'focus';

export type PageAmbientId = 'none' | 'grid' | 'peg';

export type GridPageRevealSpeed = 'fast' | 'normal' | 'slow';

export type AppAppearance = {
  themeId: ThemeId;
  appName: string;
  tagline: string;
  openingScene: OpeningScene;
  introDurationMs: number;
  showConeMascot: boolean;
  customIconDataUrl: string;
  customIconRgbaB64: string;
  density: 'comfortable' | 'compact';
  radius: 'rounded' | 'sharp';
  wallpaper: 'campfire' | 'none' | 'ember';
  appLayout: AppLayoutId;
  conePetLook: 'default' | 'ember' | 'custom';
  homeBackgroundId: HomeBackgroundId;
  homeBackgroundBlur: boolean;
  homeBackgroundBlurIntensity: number;
  homeWidgets: HomeWidget[];
  homeTrackerMode: HomeTrackerMode;
  launchHeroSize: LaunchHeroSize;
  gridPageReveal: boolean;
  gridPageRevealSpeed: GridPageRevealSpeed;
  pageAmbient: PageAmbientId;
};

export const APPEARANCE_PRESET_VERSION = 6;

export type AppearancePreset = {
  version: number;
  exportedAt: string;
  appearance: AppAppearance;
};

export const defaultHomeWidgets: HomeWidget[] = [
  { id: 'quickActions', visible: true, zone: 'main', size: 'regular' },
  { id: 'weeklyPicks', visible: true, zone: 'main', size: 'regular' },
  { id: 'announcements', visible: true, zone: 'main', size: 'regular' },
  { id: 'account', visible: true, zone: 'rail', size: 'regular' },
  { id: 'health', visible: true, zone: 'rail', size: 'regular' },
  { id: 'community', visible: true, zone: 'rail', size: 'regular' },
  { id: 'loadouts', visible: true, zone: 'rail', size: 'regular' },
  { id: 'assistant', visible: false, zone: 'below', size: 'regular' },
  { id: 'music', visible: false, zone: 'below', size: 'compact' },
  { id: 'managed', visible: true, zone: 'main', size: 'regular' },
  { id: 'modChecker', visible: false, zone: 'main', size: 'compact' },
  { id: 'studio', visible: false, zone: 'rail', size: 'regular' },
  { id: 'backups', visible: false, zone: 'rail', size: 'regular' },
  { id: 'tracker', visible: false, zone: 'rail', size: 'compact' },
];

const legacyRailWidgetIds = new Set<HomeWidgetId>([
  'account',
  'health',
  'community',
  'studio',
  'backups',
]);

export function defaultZoneForWidget(id: HomeWidgetId): HomeWidgetZone {
  return legacyRailWidgetIds.has(id) ? 'rail' : 'main';
}

export const homeWidgetCatalog: HomeWidgetId[] = defaultHomeWidgets.map((widget) => widget.id);

export const homeWidgetZoneLabels: Record<HomeWidgetZone, string> = {
  main: 'Under launch',
  rail: 'Right side',
  below: 'Bottom row',
};

export const gridPageRevealSpeedOptions: {
  id: GridPageRevealSpeed;
  label: string;
  blurb: string;
}[] = [
  { id: 'fast', label: 'Fast', blurb: 'About 0.4 seconds' },
  { id: 'normal', label: 'Normal', blurb: 'About 0.6 seconds' },
  { id: 'slow', label: 'Slow', blurb: 'About 1 second' },
];

export const gridPageRevealTiming: Record<
  GridPageRevealSpeed,
  { coverMs: number; revealMs: number }
> = {
  fast: { coverMs: 200, revealMs: 180 },
  normal: { coverMs: 320, revealMs: 300 },
  slow: { coverMs: 520, revealMs: 480 },
};

export const themePalettes: Record<ThemeId, ThemePalette> = {
  default: {
    orange: '#FF8A1F',
    accent: '#FF8A1F',
    focus: '#FFB56A',
    burnt: '#C4660C',
    brown: '#5A4030',
    shellA: '#151413',
    shellB: '#0E0E0E',
    sidebarA: '#1A1816',
    sidebarB: '#181715',
    panel: '#1A1816',
    panelSoft: '#1E1C19',
    text: '#F6F5F3',
    muted: '#7C766C',
    line: '#ffffff12',
    scrollA: '#5A564E',
    scrollB: '#3A3732',
    scrollTrack: '#0A0A0A',
    inputBg: '#121110',
    inputBorder: '#2A2724',
    inputText: '#F6F5F3',
  },
  ember: {
    orange: '#FF7A18',
    accent: '#FF6A10',
    focus: '#FFA050',
    burnt: '#A04010',
    brown: '#3A1C10',
    shellA: '#1A1412',
    shellB: '#0C0A09',
    sidebarA: '#1C1614',
    sidebarB: '#14100E',
    panel: '#221A16',
    panelSoft: '#1C1612',
    text: '#F0E6DC',
    muted: '#9A8A7C',
    line: '#ffffff14',
    scrollA: '#8A4A28',
    scrollB: '#5A2814',
    scrollTrack: '#080605',
    inputBg: '#140E0C',
    inputBorder: '#4A3020',
    inputText: '#F0E6DC',
  },
};

export const defaultAppearance: AppAppearance = {
  themeId: 'default',
  appName: 'ii Engine',
  tagline: 'PLAY FURTHER',
  openingScene: 'minimal',
  introDurationMs: 900,
  showConeMascot: true,
  customIconDataUrl: '',
  customIconRgbaB64: '',
  density: 'comfortable',
  radius: 'rounded',
  wallpaper: 'none',
  appLayout: 'classic',
  conePetLook: 'default',
  homeBackgroundId: 'none',
  homeBackgroundBlur: false,
  homeBackgroundBlurIntensity: 8,
  homeWidgets: defaultHomeWidgets.map((widget) => ({ ...widget })),
  homeTrackerMode: 'lastPlayer',
  launchHeroSize: 'regular',
  gridPageReveal: false,
  gridPageRevealSpeed: 'normal',
  pageAmbient: 'none',
};

export const homeTrackerModeOptions: {
  id: HomeTrackerMode;
  label: string;
  blurb: string;
}[] = [
  { id: 'lastPlayer', label: 'Last player', blurb: 'Most recent lobby sightings' },
  { id: 'lastRare', label: 'Last rare', blurb: 'Latest special cosmetics' },
  { id: 'targets', label: 'Targets', blurb: 'Players on your Target Tracker' },
];

export const pageAmbientOptions: {
  id: PageAmbientId;
  label: string;
  blurb: string;
}[] = [
  { id: 'none', label: 'Off', blurb: 'No background pattern.' },
  { id: 'grid', label: 'Grid', blurb: 'Light grid that follows your mouse.' },
  { id: 'peg', label: 'Dots', blurb: 'Soft dots that follow your mouse.' },
];

export const appLayoutOptions: { id: AppLayoutId; label: string; blurb: string }[] = [
  { id: 'classic', label: 'Classic', blurb: 'Normal sidebar and content width.' },
  { id: 'wide', label: 'Wide', blurb: 'Thinner sidebar, more room for content.' },
  { id: 'focus', label: 'Focus', blurb: 'Tighter spacing on Home.' },
];

export const homeBackgroundOptions: {
  id: HomeBackgroundId;
  label: string;
  blurb: string;
}[] = [
  { id: 'none', label: 'None', blurb: 'No photo on Home.' },
  { id: 'mountain', label: 'Mountains', blurb: 'Sunset hills behind Home.' },
  { id: 'mines', label: 'Mines', blurb: 'Warm tunnel behind Home.' },
  { id: 'campfire', label: 'Campfire', blurb: 'Night forest behind Home.' },
  { id: 'caves', label: 'Caves', blurb: 'Blue crystals behind Home.' },
  { id: 'canyon', label: 'Canyon', blurb: 'Orange cavern behind Home.' },
  {
    id: 'cat',
    label: 'Cone cat',
    blurb: 'Secret. Needs the “I killed the cone” Discord role.',
  },
];

function migrateHomeBackgroundId(value: unknown): HomeBackgroundId {
  if (
    value === 'none' ||
    value === 'mountain' ||
    value === 'mines' ||
    value === 'campfire' ||
    value === 'caves' ||
    value === 'canyon' ||
    value === 'cat'
  ) {
    return value;
  }
  return 'none';
}

export const themeOptions: { id: ThemeId; label: string; blurb: string }[] = [
  {
    id: 'default',
    label: 'Gray',
    blurb: 'Dark gray with orange accents.',
  },
  {
    id: 'ember',
    label: 'Warm',
    blurb: 'Darker shell with warmer orange.',
  },
];

export const openingOptions: { id: OpeningScene; label: string }[] = [
  { id: 'cone', label: 'Cone' },
  { id: 'ember', label: 'Warm' },
  { id: 'pulse', label: 'Flash' },
  { id: 'minimal', label: 'Simple' },
];

export function moveHomeWidget(
  widgets: HomeWidget[],
  id: HomeWidgetId,
  toVisibleIndex: number,
): HomeWidget[] {
  const visible = widgets.filter((widget) => widget.visible);
  const hidden = widgets.filter((widget) => !widget.visible);
  const from = visible.findIndex((widget) => widget.id === id);
  if (from < 0) return widgets;
  const to = Math.max(0, Math.min(visible.length - 1, toVisibleIndex));
  if (from === to) return widgets;
  const next = [...visible];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return [...next, ...hidden];
}

export function moveHomeWidgetToZone(
  widgets: HomeWidget[],
  id: HomeWidgetId,
  zone: HomeWidgetZone,
  toIndexInZone: number,
): HomeWidget[] {
  const target = widgets.find((widget) => widget.id === id);
  if (!target || !target.visible) return widgets;

  const zoneBefore = widgets.filter((widget) => widget.visible && widget.zone === zone);
  const fromIndex = zoneBefore.findIndex((widget) => widget.id === id);
  let insertAt = Math.max(0, Math.min(zoneBefore.length, toIndexInZone));
  if (fromIndex >= 0 && target.zone === zone && insertAt > fromIndex) insertAt -= 1;

  const others = widgets.filter((widget) => widget.id !== id);
  const zoneVisible = others.filter((widget) => widget.visible && widget.zone === zone);
  const rest = others.filter((widget) => !(widget.visible && widget.zone === zone));
  insertAt = Math.max(0, Math.min(zoneVisible.length, insertAt));
  const moved: HomeWidget = { ...target, zone, visible: true };
  if (
    fromIndex >= 0 &&
    target.zone === zone &&
    insertAt === fromIndex &&
    target.size === moved.size
  ) {
    return widgets;
  }
  zoneVisible.splice(insertAt, 0, moved);
  return [...zoneVisible, ...rest];
}

export function setHomeWidgetSize(
  widgets: HomeWidget[],
  id: HomeWidgetId,
  size: HomeWidgetSize,
): HomeWidget[] {
  return widgets.map((widget) => (widget.id === id ? { ...widget, size } : widget));
}

export function setHomeWidgetVisible(
  widgets: HomeWidget[],
  id: HomeWidgetId,
  visible: boolean,
): HomeWidget[] {
  const known = new Set(homeWidgetCatalog);
  if (!known.has(id)) return widgets;
  const existing = widgets.find((widget) => widget.id === id);
  if (existing) {
    return widgets.map((widget) => (widget.id === id ? { ...widget, visible } : widget));
  }
  const fallback = defaultHomeWidgets.find((widget) => widget.id === id) ?? {
    id,
    visible: false,
    zone: defaultZoneForWidget(id),
    size: 'regular' as HomeWidgetSize,
  };
  return [...widgets, { ...fallback, visible }];
}

function normalizeHomeWidget(raw: Partial<HomeWidget> & { id?: string }): HomeWidget | null {
  const id = raw.id as HomeWidgetId | undefined;
  if (!id || !homeWidgetCatalog.includes(id)) return null;
  const fallback = defaultHomeWidgets.find((widget) => widget.id === id)!;
  const zone: HomeWidgetZone =
    raw.zone === 'main' || raw.zone === 'rail' || raw.zone === 'below'
      ? raw.zone
      : defaultZoneForWidget(id);
  const size: HomeWidgetSize = raw.size === 'compact' ? 'compact' : 'regular';
  return {
    id,
    visible: raw.visible ?? fallback.visible,
    zone,
    size,
  };
}

export const homeWidgetLabels: Record<HomeWidgetId, string> = {
  announcements: 'Latest announcements',
  quickActions: 'Quick actions',
  account: 'Account & status card',
  managed: 'Featured / managed content',
  assistant: 'Menu AI chat',
  modChecker: 'AI mod checker',
  music: 'Background music',
  health: 'Health & Repair shortcut',
  community: 'Community shortcut',
  studio: 'ii Studio shortcut',
  backups: 'Backups shortcut',
  weeklyPicks: 'Top 3 picks of the week',
  loadouts: 'Mod loadouts',
  tracker: 'Tracker pills',
};

export const homeWidgetBlurbs: Record<HomeWidgetId, string> = {
  announcements: 'Server announcements feed',
  quickActions: 'Launch, mods, repair tiles',
  account: 'Discord account and install status',
  managed: 'Featured staff content',
  assistant: 'Ask about ii Reborn Menu features',
  modChecker: 'Scan a DLL for malware risk',
  music: 'Quiet local + preset playlist',
  health: 'Jump to Health & Repair',
  community: 'Jump to Community',
  studio: 'Jump to ii Studio',
  backups: 'Jump to Backups',
  weeklyPicks: 'Community + trusted favorites this week',
  loadouts: 'Pro named mod sets (Engine Pro)',
  tracker: 'Pro: recent players, rares, or targets (off by default)',
};

function migrateThemeId(value: unknown): ThemeId {
  if (value === 'ember' || value === 'default') return value;
  if (value === 'kraken') return 'default';
  if (value === 'classic' || value === 'neon' || value === 'violet' || value === 'ocean') {
    return 'default';
  }
  if (value === 'crimson' || value === 'midnight' || value === 'mint' || value === 'forest') {
    return 'ember';
  }
  return 'default';
}

export function normalizeAppearance(partial?: Partial<AppAppearance> | null): AppAppearance {
  const incoming = { ...(partial ?? {}) } as Partial<AppAppearance> & {
    brandIcon?: string;
    customAccent?: string;
    customSecondary?: string;
    customTertiary?: string;
  };
  if ('brandIcon' in incoming) delete incoming.brandIcon;
  if ('customAccent' in incoming) delete incoming.customAccent;
  if ('customSecondary' in incoming) delete incoming.customSecondary;
  if ('customTertiary' in incoming) delete incoming.customTertiary;

  const base = { ...defaultAppearance, ...incoming };
  const themeId = migrateThemeId(base.themeId);
  const scene = (['cone', 'ember', 'minimal', 'pulse'] as OpeningScene[]).includes(
    base.openingScene as OpeningScene,
  )
    ? (base.openingScene as OpeningScene)
    : 'cone';
  const widgets = Array.isArray(partial?.homeWidgets)
    ? partial!.homeWidgets
    : Array.isArray(base.homeWidgets)
      ? base.homeWidgets
      : defaultHomeWidgets;
  const byId = new Map<HomeWidgetId, HomeWidget>();
  for (const raw of widgets) {
    const normalized = normalizeHomeWidget(raw as Partial<HomeWidget> & { id?: string });
    if (normalized) byId.set(normalized.id, normalized);
  }
  const orderedIds = [
    ...widgets
      .map((widget) => (widget as { id?: HomeWidgetId }).id)
      .filter((id): id is HomeWidgetId => !!id && byId.has(id)),
    ...homeWidgetCatalog.filter((id) => !byId.has(id)),
  ];
  const uniqueIds = [...new Set(orderedIds)];
  const layout = (['classic', 'wide', 'focus'] as AppLayoutId[]).includes(
    base.appLayout as AppLayoutId,
  )
    ? (base.appLayout as AppLayoutId)
    : 'classic';
  const revealSpeed = (['fast', 'normal', 'slow'] as GridPageRevealSpeed[]).includes(
    base.gridPageRevealSpeed as GridPageRevealSpeed,
  )
    ? (base.gridPageRevealSpeed as GridPageRevealSpeed)
    : 'normal';
  return {
    ...base,
    themeId,
    openingScene: scene,
    appLayout: layout,
    conePetLook:
      base.conePetLook === 'ember' ||
      base.conePetLook === 'custom' ||
      base.conePetLook === 'default'
        ? base.conePetLook
        : 'default',
    customIconDataUrl: typeof base.customIconDataUrl === 'string' ? base.customIconDataUrl : '',
    customIconRgbaB64: typeof base.customIconRgbaB64 === 'string' ? base.customIconRgbaB64 : '',
    showConeMascot: !base.customIconDataUrl,
    appName: (typeof base.appName === 'string' ? base.appName : 'ii Engine').slice(0, 32),
    tagline: (typeof base.tagline === 'string' ? base.tagline : 'PLAY FURTHER').slice(0, 40),
    homeBackgroundId: migrateHomeBackgroundId(base.homeBackgroundId),
    homeBackgroundBlur: Boolean(base.homeBackgroundBlur),
    homeBackgroundBlurIntensity: Math.min(
      40,
      Math.max(4, Number(base.homeBackgroundBlurIntensity) || 12),
    ),
    launchHeroSize: base.launchHeroSize === 'compact' ? 'compact' : 'regular',
    homeTrackerMode: (['lastPlayer', 'lastRare', 'targets'] as HomeTrackerMode[]).includes(
      base.homeTrackerMode as HomeTrackerMode,
    )
      ? (base.homeTrackerMode as HomeTrackerMode)
      : 'lastPlayer',
    gridPageReveal: Boolean(base.gridPageReveal),
    gridPageRevealSpeed: revealSpeed,
    pageAmbient: (['none', 'grid', 'peg'] as PageAmbientId[]).includes(
      base.pageAmbient as PageAmbientId,
    )
      ? (base.pageAmbient as PageAmbientId)
      : 'none',
    homeWidgets: uniqueIds.map((id) => {
      const existing = byId.get(id);
      const fallback = defaultHomeWidgets.find((widget) => widget.id === id)!;
      return existing
        ? existing
        : {
            id,
            visible: fallback.visible,
            zone: fallback.zone,
            size: fallback.size,
          };
    }),
  };
}

export function exportAppearancePreset(appearance: AppAppearance): AppearancePreset {
  return {
    version: APPEARANCE_PRESET_VERSION,
    exportedAt: new Date().toISOString(),
    appearance: normalizeAppearance(appearance),
  };
}

export function importAppearancePreset(raw: unknown): AppAppearance {
  const data = raw as Partial<AppearancePreset> & { appearance?: Partial<AppAppearance> };
  if (!data || typeof data !== 'object' || !data.appearance) {
    throw new Error('Not a valid ii Engine Customize preset.');
  }
  return normalizeAppearance(data.appearance);
}

export function appearanceClassNames(appearance: AppAppearance) {
  const parts = [
    `theme-${appearance.themeId}`,
    `density-${appearance.density}`,
    `radius-${appearance.radius}`,
    `layout-${appearance.appLayout ?? 'classic'}`,
  ];
  if (appearance.wallpaper !== 'none') parts.push(`wallpaper-${appearance.wallpaper}`);
  return parts.join(' ');
}

export function appearanceStyle(appearance: AppAppearance): CSSProperties {
  const palette = themePalettes[appearance.themeId] ?? themePalettes.default;
  const style: Record<string, string> = {
    '--app-name': `"${appearance.appName.replaceAll('"', '')}"`,
    '--orange': palette.orange,
    '--accent': palette.accent,
    '--focus': palette.focus,
    '--burnt': palette.burnt,
    '--brown': palette.brown,
    '--shell-a': palette.shellA,
    '--shell-b': palette.shellB,
    '--sidebar-a': palette.sidebarA,
    '--sidebar-b': palette.sidebarB,
    '--panel': palette.panel,
    '--panel-soft': palette.panelSoft,
    '--white': palette.text,
    '--muted': palette.muted,
    '--line': palette.line,
    '--scroll-a': palette.scrollA,
    '--scroll-b': palette.scrollB,
    '--scroll-track': palette.scrollTrack,
    '--input-bg': palette.inputBg,
    '--input-border': palette.inputBorder,
    '--input-text': palette.inputText,
    '--text': palette.text,
    '--bg': palette.shellB,
    '--shell-elevated': palette.sidebarA,
  };
  return style as CSSProperties;
}

export function applyAppearanceToDocument(appearance: AppAppearance) {
  const style = appearanceStyle(appearance) as Record<string, string>;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(style)) {
    if (key.startsWith('--')) root.style.setProperty(key, value);
  }
}

export async function encodeCustomIcon(file: File): Promise<{
  previewDataUrl: string;
  rgbaB64: string;
  width: number;
  height: number;
}> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Choose a PNG, JPG, or WebP image.');
  }
  if (file.size > 4 * 1024 * 1024) {
    throw new Error('Icon must be under 4 MB.');
  }
  const bitmap = await createImageBitmap(file);
  const previewSize = 96;
  const preview = document.createElement('canvas');
  preview.width = previewSize;
  preview.height = previewSize;
  const previewCtx = preview.getContext('2d');
  if (!previewCtx) throw new Error('Could not process icon.');
  const cover = Math.max(previewSize / bitmap.width, previewSize / bitmap.height);
  const pw = bitmap.width * cover;
  const ph = bitmap.height * cover;
  previewCtx.clearRect(0, 0, previewSize, previewSize);
  previewCtx.drawImage(bitmap, (previewSize - pw) / 2, (previewSize - ph) / 2, pw, ph);
  const previewDataUrl = preview.toDataURL('image/png');

  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process icon.');
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  const pixels = ctx.getImageData(0, 0, size, size).data;
  let binary = '';
  for (let i = 0; i < pixels.length; i += 1) binary += String.fromCharCode(pixels[i]!);
  bitmap.close();
  return { previewDataUrl, rgbaB64: btoa(binary), width: size, height: size };
}
