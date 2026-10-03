import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  defaultAppearance,
  defaultHomeWidgets,
  normalizeAppearance,
  type AppAppearance,
  type OpeningScene,
  type ThemeId,
} from './appearance';
import type { KrakenSession } from './kraken';

export const pages = ['Home', 'Health & Repair', 'Backups', 'Settings'] as const;
export type Page =
  | (typeof pages)[number]
  | 'ii Studio'
  | 'Autoloader'
  | 'Catalog'
  | 'Community'
  | 'Plans'
  | 'Staff'
  | 'Customize'
  | 'Experimental'
  | 'Tracker'
  | 'Self Tracker'
  | 'Target Tracker'
  | 'Tracker Scout'
  | 'ii SoundLab';
type PreferenceKey =
  | 'reduceMotion'
  | 'minimize'
  | 'closeToTray'
  | 'telemetry'
  | 'anonymousChat'
  | 'studioAiAutocomplete';
export type PlanOverride = 'auto' | 'free' | 'pro';
export type TrackerAccessOverride = 'auto' | 'on' | 'off';
type Preferences = {
  reduceMotion: boolean;
  minimize: boolean;
  closeToTray: boolean;
  telemetry: boolean | null;
  anonymousChat: boolean;
  studioAiAutocomplete: boolean;
  appearance: AppAppearance;
  selectedReleaseId: string | null;
  onboardingComplete: boolean;
  planOverride: PlanOverride;
  trackerAccessOverride: TrackerAccessOverride;
  sidebarCollapsed: boolean;
  krakenSession: KrakenSession | null;
  communityMentionUnread: boolean;
  setPreference: (key: PreferenceKey, value: boolean) => void;
  setAppearance: (patch: Partial<AppAppearance>) => void;
  resetAppearance: () => void;
  setSelectedRelease: (value: string | null) => void;
  completeOnboarding: () => void;
  setPlanOverride: (value: PlanOverride) => void;
  setTrackerAccessOverride: (value: TrackerAccessOverride) => void;
  setSidebarCollapsed: (value: boolean) => void;
  setKrakenSession: (session: KrakenSession | null) => void;
  setCommunityMentionUnread: (value: boolean) => void;
};

export const usePreferences = create<Preferences>()(
  persist(
    (set) => ({
      reduceMotion: false,
      minimize: true,
      closeToTray: false,
      telemetry: true,
      anonymousChat: false,
      studioAiAutocomplete: true,
      appearance: normalizeAppearance(defaultAppearance),
      selectedReleaseId: null,
      onboardingComplete: false,
      planOverride: 'auto',
      trackerAccessOverride: 'auto',
      sidebarCollapsed: false,
      krakenSession: null,
      communityMentionUnread: false,
      setPreference: (key, value) => set({ [key]: value }),
      setAppearance: (patch) =>
        set((state) => ({
          appearance: normalizeAppearance({
            ...state.appearance,
            ...patch,
            appName: (patch.appName ?? state.appearance.appName).slice(0, 32),
            tagline: (patch.tagline ?? state.appearance.tagline).slice(0, 40),
            introDurationMs: Math.min(
              4000,
              Math.max(600, patch.introDurationMs ?? state.appearance.introDurationMs),
            ),
          }),
        })),
      resetAppearance: () => set({ appearance: normalizeAppearance(defaultAppearance) }),
      setSelectedRelease: (value) => set({ selectedReleaseId: value }),
      completeOnboarding: () => set({ onboardingComplete: true }),
      setPlanOverride: (value) => set({ planOverride: value }),
      setTrackerAccessOverride: (value) => set({ trackerAccessOverride: value }),
      setSidebarCollapsed: (value) => set({ sidebarCollapsed: value }),
      setKrakenSession: (session) => set({ krakenSession: session }),
      setCommunityMentionUnread: (value) => set({ communityMentionUnread: Boolean(value) }),
    }),
    {
      name: 'ii-engine-preferences',
      version: 8,
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        let next = { ...state };
        if (version < 2) {
          next = { ...next, closeToTray: false };
        }
        if (version < 3) {
          const appearance = (next.appearance ?? {}) as Record<string, unknown>;
          const themeId = appearance.themeId ?? 'default';
          if (
            (themeId === 'default' || themeId === undefined) &&
            (appearance.wallpaper === 'campfire' || appearance.wallpaper === undefined)
          ) {
            next = {
              ...next,
              appearance: { ...appearance, wallpaper: 'none' },
            };
          }
        }
        if (version < 4) {
          const appearance = (next.appearance ?? {}) as Record<string, unknown>;
          next = {
            ...next,
            appearance: {
              ...appearance,
              themeId: appearance.themeId ?? 'default',
              homeBackgroundId: 'none',
              homeBackgroundBlur: false,
              homeWidgets: defaultHomeWidgets.map((widget) => ({ ...widget })),
              radius: 'rounded',
              wallpaper: 'none',
            },
          };
        }
        if (version < 5) {
          next = { ...next, communityMentionUnread: Boolean(next.communityMentionUnread) };
        }
        if (version < 6) {
          const appearance = (next.appearance ?? {}) as Record<string, unknown>;
          const widgets = Array.isArray(appearance.homeWidgets)
            ? (appearance.homeWidgets as Array<Record<string, unknown>>)
            : null;
          if (widgets) {
            next = {
              ...next,
              appearance: {
                ...appearance,
                homeWidgets: widgets.map((widget) =>
                  widget?.id === 'managed' ? { ...widget, visible: true } : widget,
                ),
              },
            };
          }
        }
        if (version < 7) {
          const appearance = (next.appearance ?? {}) as Record<string, unknown>;
          const widgets = Array.isArray(appearance.homeWidgets)
            ? (appearance.homeWidgets as Array<Record<string, unknown>>)
            : [];
          const hasTracker = widgets.some((widget) => widget?.id === 'tracker');
          next = {
            ...next,
            appearance: {
              ...appearance,
              homeTrackerMode:
                appearance.homeTrackerMode === 'lastRare' ||
                appearance.homeTrackerMode === 'targets' ||
                appearance.homeTrackerMode === 'lastPlayer'
                  ? appearance.homeTrackerMode
                  : 'lastPlayer',
              homeWidgets: hasTracker
                ? widgets
                : [...widgets, { id: 'tracker', visible: false, zone: 'rail', size: 'compact' }],
            },
          };
        }
        if (version < 8) {
          next = { ...next, trackerAccessOverride: 'auto' };
        }
        return next;
      },
      partialize: ({
        reduceMotion,
        minimize,
        closeToTray,
        telemetry,
        anonymousChat,
        studioAiAutocomplete,
        appearance,
        selectedReleaseId,
        onboardingComplete,
        planOverride,
        trackerAccessOverride,
        sidebarCollapsed,
        krakenSession,
        communityMentionUnread,
      }) => ({
        reduceMotion,
        minimize,
        closeToTray,
        telemetry,
        anonymousChat,
        studioAiAutocomplete,
        appearance,
        selectedReleaseId,
        onboardingComplete,
        planOverride,
        trackerAccessOverride,
        sidebarCollapsed,
        krakenSession,
        communityMentionUnread,
      }),
      merge: (persisted, current) => {
        const incoming = (persisted ?? {}) as Partial<Preferences>;
        const trackerOverride = incoming.trackerAccessOverride;
        return {
          ...current,
          ...incoming,
          closeToTray: incoming.closeToTray === true,
          telemetry:
            incoming.telemetry === false
              ? false
              : incoming.telemetry === true
                ? true
                : current.telemetry !== false,
          studioAiAutocomplete:
            incoming.studioAiAutocomplete === undefined
              ? true
              : Boolean(incoming.studioAiAutocomplete),
          sidebarCollapsed: Boolean(incoming.sidebarCollapsed),
          trackerAccessOverride:
            trackerOverride === 'on' || trackerOverride === 'off' || trackerOverride === 'auto'
              ? trackerOverride
              : current.trackerAccessOverride,
          appearance: normalizeAppearance({
            ...defaultAppearance,
            ...(incoming.appearance ?? {}),
          }),
          krakenSession: incoming.krakenSession ?? null,
          communityMentionUnread: Boolean(incoming.communityMentionUnread),
        };
      },
    },
  ),
);

export type { ThemeId, OpeningScene, AppAppearance };

export const launchStates = [
  'Checking',
  'Downloading',
  'Verifying',
  'Backing up',
  'Installing',
  'Ready',
  'Launching',
  'Running',
  'Failed',
] as const;
