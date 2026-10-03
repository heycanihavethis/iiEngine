import {
  lazy,
  Suspense,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, MotionConfig } from 'motion/react';
import {
  ArrowRight,
  Bell,
  CircleHelp,
  ExternalLink,
  MessageSquare,
  RefreshCw,
  Users,
} from 'lucide-react';
import cone from '../../../packages/brand/cone.svg';
import coneEmber from '../../../packages/brand/cone-ember.svg';
import {
  ApiError,
  adminErrorDetail,
  apiRequest,
  deleteAccount,
  ensureFreshSession,
  errorMessage,
  getDashboard,
  hasAccessToken,
  initializeSession,
  isSessionExpiredError,
  signIn,
  signOut,
} from './api';
import Health from './Health';
import Diagnostics from './Diagnostics';
import Home from './Home';
import Developer from './Developer';
import Backups from './Backups';
import InviteSettings from './InviteSettings';
import { EngineIcon, type EngineIconName } from './EngineIcon';
import {
  dashboardFromMembershipCache,
  mergeDashboardWithMembershipCache,
  readMembershipCache,
} from './membershipCache';
import { prefetchLatestMenu } from './launcher';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { pages, usePreferences, type Page } from './store';
import {
  appearanceClassNames,
  appearanceStyle,
  applyAppearanceToDocument,
  defaultAppearance,
  gridPageRevealTiming,
} from './appearance';
import { Startup } from './Startup';
import { externalClick } from './external';
import { recoverKrakenSession } from './krakenDesktop';
import {
  CONE_KILLER_ROLE_ID,
  II_TRACKER_BETA_ROLE_ID,
  featureAllowed,
  hasProAccess,
  mergeFeatureAccess,
  type FeatureAccess,
} from './featureAccess';
import { notifyMentionDesktop, playMentionPing } from './mentionNotify';
import { trackFeature, beginSession, flushSessionLog } from './telemetry';
import { lazyPage } from './lazyPage';
import FirstRunTutorial, { buildTourSteps } from './Tutorial';
import PageRevealGrid, { inspectPageEntryHealth, type PageRevealPhase } from './PageRevealGrid';
import AmbientBackdrop from './AmbientBackdrop';
import { preloadPageChunk } from './pagePreload';

const Customize = lazy(() => import('./Customize'));
const Tracker = lazy(() => import('./Tracker'));
const SelfTracker = lazy(() => import('./SelfTracker'));
const TrackerScout = lazy(() => import('./TrackerScout'));
const SoundLab = lazyPage(() => import('./SoundLab'), 'ii SoundLab');
const icons: Record<(typeof pages)[number], EngineIconName> = {
  Home: 'home',
  'Health & Repair': 'health',
  Backups: 'backup',
  Settings: 'settings',
};
const Legal = lazy(() => import('./Legal'));
const Studio = lazy(() => import('./Studio'));
const AutoLoader = lazyPage(
  () => import('./AutoLoader'),
  'Mod Library',
  import.meta.env.DEV
    ? () =>
        import(/* @vite-ignore */ `./AutoLoader.tsx?t=${Date.now()}`) as Promise<
          typeof import('./AutoLoader')
        >
    : undefined,
);
const Community = lazy(() => import('./Community'));
const Catalog = lazyPage(() => import('./Catalog'), 'Catalog');
const Plans = lazy(() => import('./Plans'));
const official = 'https://discord.gg/iidk';

export default function App() {
  const studioWindow = new URLSearchParams(window.location.search).get('studio') === '1';
  const [page, setPage] = useState<Page>(studioWindow ? 'ii Studio' : 'Home');
  const [entered, setEntered] = useState(studioWindow);
  const [demoSignedIn, setDemoSignedIn] = useState(false);
  const [notice, setNotice] = useState('');
  const [membershipSoftChecking, setMembershipSoftChecking] = useState(false);
  const membershipSoftTried = useRef(false);
  const [healthStatus, setHealthStatus] = useState('Not checked');
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [uninstallArmed, setUninstallArmed] = useState(false);
  const [uninstallBusy, setUninstallBusy] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notificationBox, setNotificationBox] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const [tourActive, setTourActive] = useState(false);
  const sidebarBeforeTour = useRef<boolean | null>(null);
  const [coneHits, setConeHits] = useState(0);
  const [coneDead, setConeDead] = useState(false);
  const [coneAnim, setConeAnim] = useState<'idle' | 'hit' | 'dying' | 'dead'>('idle');
  const [coneRoleToast, setConeRoleToast] = useState<{ title: string; body: string } | null>(null);
  const coneHitTimer = useRef<number | null>(null);
  const coneDeathTimer = useRef<number | null>(null);
  const coneToastTimer = useRef<number | null>(null);
  const [pageReveal, setPageReveal] = useState<PageRevealPhase | null>(null);
  const [pageRevealGen, setPageRevealGen] = useState(0);
  const pageRevealActive = useRef(false);
  const pendingRevealPage = useRef<Page | null>(null);
  const notificationBtnRef = useRef<HTMLButtonElement | null>(null);
  const notificationMenuRef = useRef<HTMLDivElement | null>(null);
  const prefs = usePreferences();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!isTauri()) return;
    void invoke('set_window_preferences', { closeToTray: prefs.closeToTray }).catch(() => {});
  }, [prefs.closeToTray]);
  useEffect(() => {
    beginSession();
    trackFeature('app', 'session_start');
  }, []);
  useEffect(() => {
    if (!isTauri()) {
      const onHide = () => {
        void flushSessionLog('pagehide');
      };
      window.addEventListener('pagehide', onHide);
      return () => window.removeEventListener('pagehide', onHide);
    }
    const subscription = listen('app-quit-requested', async () => {
      await flushSessionLog('quit');
      try {
        await invoke('confirm_app_exit');
      } catch {}
    });
    return () => {
      void subscription.then((unlisten) => unlisten());
    };
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    const subscription = listen<string>('tray-action', (event) => {
      setPage(event.payload === 'health' ? 'Health & Repair' : 'Home');
    });
    return () => {
      void subscription.then((unlisten) => unlisten());
    };
  }, []);
  const loginCancel = useRef<AbortController | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  useEffect(() => () => loginCancel.current?.abort(), []);
  useEffect(
    () => () => {
      if (coneHitTimer.current) window.clearTimeout(coneHitTimer.current);
      if (coneDeathTimer.current) window.clearTimeout(coneDeathTimer.current);
      if (coneToastTimer.current) window.clearTimeout(coneToastTimer.current);
    },
    [],
  );
  async function login() {
    const controller = new AbortController();
    loginCancel.current = controller;
    setLoggingIn(true);
    setNotice('Opening Discord sign-in…');
    try {
      await signIn(controller.signal, setNotice);
      setNotice('');
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (error) {
      setNotice(errorMessage(error, 'Sign-in failed.'));
    } finally {
      setLoggingIn(false);
      loginCancel.current = null;
    }
  }
  async function logout(disconnect = false) {
    if (accountBusy) return;
    setAccountBusy(true);
    if (data?.demo) {
      setDemoSignedIn(false);
      setEntered(false);
      setAccountBusy(false);
      return;
    }
    try {
      const result = await signOut(disconnect);
      setNotice(result.message || 'Signed out.');
    } catch (error) {
      setNotice(errorMessage(error, "Couldn't reach your account right now. Try again."));
    } finally {
      setAccountBusy(false);
      setEntered(false);
      queryClient.removeQueries({ queryKey: ['dashboard'] });
      await query.refetch();
    }
  }

  async function uninstallEngine() {
    if (uninstallBusy) return;
    setUninstallBusy(true);
    try {
      if (!isTauri()) {
        setNotice('Open the Windows ii Engine app to uninstall it from this PC.');
        return;
      }
      const message = await invoke<string>('open_engine_uninstaller');
      setNotice(message);
      setUninstallArmed(false);
    } catch (error) {
      setNotice(
        errorMessage(error, 'Could not open the uninstaller. Try Windows Settings → Apps.'),
      );
    } finally {
      setUninstallBusy(false);
    }
  }
  const query = useQuery({
    queryKey: ['dashboard'],
    queryFn: async () => {
      await initializeSession();
      if (isTauri() && !hasAccessToken()) {
        throw new ApiError('Sign in to continue.', 401);
      }
      try {
        const dashboard = await getDashboard();
        return await mergeDashboardWithMembershipCache(dashboard);
      } catch (error) {
        if (!isSessionExpiredError(error)) {
          const cached = await readMembershipCache();
          if (cached) return dashboardFromMembershipCache(cached);
        }
        throw error;
      }
    },
    refetchInterval: page === 'Home' ? 30000 : false,
    refetchIntervalInBackground: false,
  });
  const data = query.data;
  const membershipCached = Boolean(
    data && 'membershipCached' in data && (data as { membershipCached?: boolean }).membershipCached,
  );
  const signedIn = data && (data.demo ? demoSignedIn : true);
  useEffect(() => {
    if (!isTauri() || !signedIn || data?.demo) return;
    const keepAlive = () => {
      void ensureFreshSession().catch(() => {});
    };
    keepAlive();
    const timer = window.setInterval(keepAlive, 8 * 60 * 1000);
    const onFocus = () => keepAlive();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [signedIn, data?.demo]);
  const features = useQuery({
    queryKey: ['platform-feature-access'],
    queryFn: async () =>
      (await (await apiRequest('/v1/platform/operations')).json()) as {
        feature_access?: FeatureAccess;
      },
    enabled: !!signedIn && !data?.demo,
    retry: false,
    refetchInterval: 60_000,
  });
  const access = mergeFeatureAccess(features.data?.feature_access);
  const roleIds = data?.member.roles.map((role) => role.id) ?? [];
  const entitlements = data?.member.entitlements ?? [];
  const naturalPro = hasProAccess(entitlements);
  const canPlanToggle =
    !!data?.demo || entitlements.some((name) => ['owner', 'admin'].includes(name));
  const planOverride = prefs.planOverride;
  const isPro =
    canPlanToggle && planOverride === 'free'
      ? false
      : canPlanToggle && planOverride === 'pro'
        ? true
        : !!data?.demo || naturalPro;
  const effectiveAppearance = isPro ? prefs.appearance : defaultAppearance;
  const displayAppearance = effectiveAppearance;
  useEffect(() => {
    applyAppearanceToDocument(displayAppearance);
  }, [displayAppearance]);
  const canStudio = !!data?.demo || featureAllowed(access.studio, roleIds, entitlements);
  const canModLibrary = !!data?.demo || featureAllowed(access.mod_library, roleIds, entitlements);
  const canCommunityChat =
    !!data?.demo ||
    featureAllowed(access.community_chat, roleIds, entitlements) ||
    featureAllowed(access.announcements, roleIds, entitlements);
  const canLaunch = !!data?.demo || featureAllowed(access.launch_game, roleIds, entitlements);
  const canHealth = !!data?.demo || featureAllowed(access.health_repair, roleIds, entitlements);
  const canBackups = !!data?.demo || featureAllowed(access.backups, roleIds, entitlements);
  const canPlans = !!data?.demo || access.plans_tab.enabled;
  const canCatalog = !!data?.demo || featureAllowed(access.catalog, roleIds, entitlements);
  const canSoundLab =
    !!data?.demo || featureAllowed(access.soundlab, roleIds, entitlements) || isPro;
  const canCustomize =
    !!data?.demo || featureAllowed(access.customize, roleIds, entitlements) || isPro;
  const canHomeAi = !!data?.demo || featureAllowed(access.home_ai, roleIds, entitlements) || isPro;
  const canSelfTracker = !!data?.demo || featureAllowed(access.self_tracker, roleIds, entitlements);
  const canDeveloperPanel =
    !!data?.demo ||
    (featureAllowed(access.developer_panel, roleIds, entitlements) &&
      entitlements.some((x) => ['developer', 'admin', 'owner'].includes(x)));
  const canStaff =
    !!data?.demo || entitlements.some((x) => ['developer', 'admin', 'owner'].includes(x));
  const coneKiller = !!data?.demo || coneDead || roleIds.includes(CONE_KILLER_ROLE_ID);
  const trackerAccessOverride = prefs.trackerAccessOverride;
  const canSeePlayerTracker = !!data?.demo || access.tracker.enabled;
  const canSeeTargetTracker = !!data?.demo || access.target_tracker.enabled;
  const canSeeTrackerScout = !!data?.demo || access.tracker_scout.enabled;
  const hasPlayerTracker =
    canPlanToggle && trackerAccessOverride === 'on'
      ? true
      : canPlanToggle && trackerAccessOverride === 'off'
        ? false
        : !!data?.demo || featureAllowed(access.tracker, roleIds, entitlements);
  const hasTargetTracker =
    canPlanToggle && trackerAccessOverride === 'on'
      ? true
      : canPlanToggle && trackerAccessOverride === 'off'
        ? false
        : !!data?.demo || featureAllowed(access.target_tracker, roleIds, entitlements);
  const hasTrackerScout =
    canPlanToggle && trackerAccessOverride === 'on'
      ? true
      : canPlanToggle && trackerAccessOverride === 'off'
        ? false
        : !!data?.demo || featureAllowed(access.tracker_scout, roleIds, entitlements);
  const hasIiTracker = hasPlayerTracker || hasTargetTracker || hasTrackerScout;
  const hasIiTrackerBeta =
    hasTargetTracker &&
    (!!data?.demo ||
      roleIds.includes(II_TRACKER_BETA_ROLE_ID) ||
      entitlements.includes('ii_tracker_beta') ||
      entitlements.some((x) => ['developer', 'admin', 'owner'].includes(x)) ||
      (canPlanToggle && trackerAccessOverride === 'on'));
  const appRule = access.app_access;
  const appLooksAccidentalLock =
    appRule.enabled &&
    !appRule.everyone &&
    appRule.role_ids.length === 0 &&
    appRule.entitlements.length === 0;
  const canUseApp =
    !!data?.demo || appLooksAccidentalLock || featureAllowed(appRule, roleIds, entitlements);
  useEffect(() => {
    if (studioWindow) {
      if (page !== 'ii Studio') setPage('ii Studio');
      return;
    }
    if (tourActive) return;
    if (
      (page === 'ii Studio' && !canStudio) ||
      (page === 'Autoloader' && !canModLibrary) ||
      (page === 'Community' && !canCommunityChat) ||
      (page === 'Plans' && !canPlans) ||
      (page === 'Health & Repair' && !canHealth) ||
      (page === 'Backups' && !canBackups) ||
      (page === 'Customize' && !canCustomize) ||
      page === 'Experimental' ||
      (page === 'ii SoundLab' && !canSoundLab) ||
      (page === 'Catalog' && !canCatalog) ||
      (page === 'Self Tracker' && !canSelfTracker) ||
      (page as string) === 'Trusted Post' ||
      (page as string) === 'Announcements' ||
      (page === 'Staff' && !canDeveloperPanel) ||
      (page === 'Tracker' && !canSeePlayerTracker) ||
      (page === 'Target Tracker' && !canSeeTargetTracker) ||
      (page === 'Tracker Scout' && !canSeeTrackerScout)
    ) {
      setPage((page as string) === 'Announcements' && canCommunityChat ? 'Community' : 'Home');
    }
  }, [
    page,
    studioWindow,
    tourActive,
    canStudio,
    canModLibrary,
    canCommunityChat,
    canPlans,
    canHealth,
    canBackups,
    canDeveloperPanel,
    canCustomize,
    canSoundLab,
    canCatalog,
    canSelfTracker,
    canSeePlayerTracker,
    canSeeTargetTracker,
    canSeeTrackerScout,
  ]);
  useEffect(() => {
    const map: Partial<Record<Page, string>> = {
      Home: 'launch_game',
      'Health & Repair': 'health_repair',
      Backups: 'backups',
      'ii Studio': 'studio',
      Autoloader: 'mod_library',
      Community: 'community_chat',
      Plans: 'plans_tab',
      Staff: 'developer_panel',
    };
    const feature = map[page];
    if (feature) trackFeature(feature, 'navigate');
  }, [page]);

  useEffect(() => {
    const session = usePreferences.getState().krakenSession;
    if (!session?.active || !isTauri() || !session.gamePath) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const cleaned = await recoverKrakenSession(session);
        if (!cancelled && cleaned) {
          usePreferences.getState().setKrakenSession(null);
          setNotice('The Kraken session ended. Extra mods were removed.');
        }
      } catch {}
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [prefs.krakenSession?.active, prefs.krakenSession?.gamePath]);

  const pageRef = useRef(page);
  pageRef.current = page;
  useEffect(() => {
    if (page === 'Community') {
      usePreferences.getState().setCommunityMentionUnread(false);
    }
  }, [page]);

  useEffect(() => {
    if (!canCommunityChat || data?.demo || !hasAccessToken()) return;
    let cancelled = false;
    const seen = new Set<string>();
    let primed = false;
    const tick = async () => {
      try {
        const response = await apiRequest('/v1/community/messages');
        if (cancelled) return;
        const items = (
          (await response.json()) as {
            items: Array<{
              id: string;
              body: string;
              mentioned_me?: boolean;
              author?: { display_name?: string };
            }>;
          }
        ).items;
        const mentions = items.filter((item) => item.mentioned_me);
        if (!primed) {
          for (const item of mentions) seen.add(item.id);
          primed = true;
          return;
        }
        for (const item of mentions) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          playMentionPing();
          if (pageRef.current === 'Community') continue;
          usePreferences.getState().setCommunityMentionUnread(true);
          const who = item.author?.display_name || 'Someone';
          const snippet = item.body.replace(/<@([0-9a-fA-F-]{36})>/g, '@member').slice(0, 140);
          void notifyMentionDesktop(
            `${who} mentioned you`,
            snippet || 'New mention in Community chat',
          );
        }
      } catch {}
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [canCommunityChat, data?.demo]);

  const navigate = useCallback(
    (value: Page) => {
      setNotificationsOpen(false);
      setNotice('');
      if (value === 'Community') {
        usePreferences.getState().setCommunityMentionUnread(false);
      }
      if (value === page && !pageRevealActive.current) return;
      if (value === pendingRevealPage.current && pageRevealActive.current) return;

      const wantReveal = isPro && effectiveAppearance.gridPageReveal && !prefs.reduceMotion;

      if (!wantReveal) {
        pageRevealActive.current = false;
        pendingRevealPage.current = null;
        setPageReveal(null);
        setPage(value);
        return;
      }

      pageRevealActive.current = true;
      pendingRevealPage.current = value;
      preloadPageChunk(value);
      setPageRevealGen((gen) => gen + 1);
      setPageReveal('covering');
    },
    [page, isPro, effectiveAppearance.gridPageReveal, prefs.reduceMotion],
  );

  const onCoverComplete = useCallback(() => {
    const next = pendingRevealPage.current;
    if (!next) {
      setPageReveal(null);
      pageRevealActive.current = false;
      return;
    }
    setPageReveal('holding');
    requestAnimationFrame(() => {
      startTransition(() => {
        setPage(next);
      });
    });
  }, []);

  useEffect(() => {
    if (pageReveal !== 'holding') return;
    let cancelled = false;

    const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

    void (async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );

      const root = document.getElementById('home');
      const softDeadline = Date.now() + 140;
      while (!cancelled && Date.now() < softDeadline) {
        if (inspectPageEntryHealth(root) !== 'loading') break;
        await wait(32);
      }

      if (cancelled) return;
      setPageReveal('revealing');
    })();

    return () => {
      cancelled = true;
    };
  }, [pageReveal, page]);

  const finishPageReveal = useCallback(() => {
    setPageReveal(null);
    pageRevealActive.current = false;
    pendingRevealPage.current = null;
  }, []);

  const tourSteps = buildTourSteps({
    canHealth,
    canModLibrary,
    canCommunityChat,
    canStudio,
  });

  const connected = !!signedIn && !query.isError;
  const healthHealthy = healthStatus === 'Healthy';
  const healthUnknown = healthStatus === 'Not checked';
  const launchTone = !connected
    ? 'offline'
    : !canLaunch || !(healthHealthy || healthUnknown)
      ? 'attention'
      : '';
  const launchLine = !connected
    ? 'Reconnecting to ii Engine…'
    : !canLaunch
      ? 'Launching is locked for this account'
      : healthHealthy
        ? 'Gorilla Tag is ready to launch'
        : healthUnknown
          ? 'Run Health & Repair to check your install'
          : `Install status: ${healthStatus}`;

  const handleTourActive = useCallback((active: boolean) => {
    setTourActive(active);
    if (active) {
      if (sidebarBeforeTour.current === null) {
        sidebarBeforeTour.current = usePreferences.getState().sidebarCollapsed;
      }
      usePreferences.getState().setSidebarCollapsed(true);
      setNotificationsOpen(false);
      return;
    }
    if (sidebarBeforeTour.current !== null) {
      usePreferences.getState().setSidebarCollapsed(sidebarBeforeTour.current);
      sidebarBeforeTour.current = null;
    }
  }, []);

  const finishTour = useCallback(() => {
    usePreferences.getState().completeOnboarding();
    navigate('Home');
  }, [navigate]);

  useLayoutEffect(() => {
    if (!notificationsOpen || !notificationBtnRef.current) {
      setNotificationBox(null);
      return;
    }
    const place = () => {
      const rect = notificationBtnRef.current!.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 24);
      setNotificationBox({
        top: rect.bottom + 9,
        left: Math.min(rect.right - width, window.innerWidth - width - 12),
        width,
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [notificationsOpen]);

  useEffect(() => {
    if (!notificationsOpen) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        notificationBtnRef.current?.contains(target) ||
        notificationMenuRef.current?.contains(target)
      ) {
        return;
      }
      setNotificationsOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNotificationsOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [notificationsOpen]);
  const windowAction = (action: 'minimize_window' | 'toggle_maximize_window' | 'close_window') => {
    if (!isTauri()) return;
    if (action === 'close_window' && prefs.closeToTray === false) {
      void (async () => {
        await flushSessionLog('window-close');
        await invoke('close_window');
      })();
      return;
    }
    void invoke(action);
  };
  const dragWindow = (event: MouseEvent<HTMLElement>) => {
    if (!isTauri() || event.button !== 0 || event.detail > 1) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea, [role="button"]')) return;
    void invoke('start_dragging_window');
  };
  const hitCone = async () => {
    if (coneDead || coneAnim === 'dying') return;
    const next = coneHits + 1;
    setConeHits(next);
    if (coneHitTimer.current) window.clearTimeout(coneHitTimer.current);
    setConeAnim('hit');
    coneHitTimer.current = window.setTimeout(() => {
      setConeAnim((current) => (current === 'hit' ? 'idle' : current));
    }, 220);
    if (next < 10) return;

    setConeDead(true);
    setConeAnim('dying');
    if (coneDeathTimer.current) window.clearTimeout(coneDeathTimer.current);
    coneDeathTimer.current = window.setTimeout(() => setConeAnim('dead'), 700);

    const alreadyHasRole = roleIds.includes(CONE_KILLER_ROLE_ID);
    const showRoleToast = (title: string, body: string) => {
      setConeRoleToast({ title, body });
      if (coneToastTimer.current) window.clearTimeout(coneToastTimer.current);
      coneToastTimer.current = window.setTimeout(() => setConeRoleToast(null), 7000);
    };

    if (data?.demo) {
      showRoleToast(
        'Hidden perk unlocked',
        'You killed the cone. Cat wallpaper is yours in Customize.',
      );
      return;
    }
    if (alreadyHasRole) {
      setNotice('The cone is down. You already have the Discord role.');
      return;
    }
    try {
      const response = await apiRequest('/v1/me/cone-kill', { method: 'POST' });
      const result = (await response.json()) as { message: string; awarded?: boolean };
      if (result.awarded !== false) {
        showRoleToast('Discord role unlocked', result.message);
      } else {
        setNotice(result.message);
      }
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (error) {
      setNotice(errorMessage(error, 'The cone fell over, but Discord could not award the role.'));
    }
  };

  useEffect(() => {
    if (!entered || !data || data.demo || data.member.membership || membershipSoftTried.current) {
      return;
    }
    membershipSoftTried.current = true;
    let cancelled = false;
    setMembershipSoftChecking(true);
    void (async () => {
      try {
        await apiRequest('/v1/me/recheck', { method: 'POST' });
        await query.refetch();
      } catch {
      } finally {
        if (!cancelled) setMembershipSoftChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entered, data, query]);

  const menuPrefetchTried = useRef(false);
  useEffect(() => {
    if (!entered) {
      menuPrefetchTried.current = false;
      return;
    }
    if (!data || data.demo || !data.member.membership || !isTauri()) {
      return;
    }
    let cancelled = false;
    const run = async (announce: boolean) => {
      const result = await prefetchLatestMenu();
      if (cancelled) return;
      await queryClient.invalidateQueries({ queryKey: ['menu-releases'] });
      if (announce && result.updateAvailable && result.release?.version) {
        setNotice(
          result.missing
            ? `ii Menu ${result.release.version} is ready to install.`
            : `ii Menu ${result.release.version} update available.`,
        );
        window.setTimeout(() => setNotice(''), 4500);
      }
    };
    if (!menuPrefetchTried.current) {
      menuPrefetchTried.current = true;
      void run(true);
    }
    const timer = window.setInterval(() => void run(false), 30 * 60 * 1000);
    const onFocus = () => {
      void run(false);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [entered, data, queryClient]);

  if (!entered) {
    return (
      <MotionConfig reducedMotion={prefs.reduceMotion ? 'always' : 'user'}>
        <Startup
          data={data}
          pending={query.isPending}
          error={query.error instanceof Error ? query.error : null}
          loggingIn={loggingIn}
          notice={notice}
          appearance={displayAppearance}
          onLogin={() => void login()}
          onContinue={() => {
            membershipSoftTried.current = false;
            setEntered(true);
          }}
          onDemo={() => {
            setDemoSignedIn(true);
            setEntered(true);
          }}
          onRetry={() => void query.refetch()}
        />
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion={prefs.reduceMotion ? 'always' : 'user'}>
      <div
        className={`app ${appearanceClassNames(displayAppearance)} ${prefs.reduceMotion ? 'reduced-motion' : ''} ${studioWindow ? 'studio-window-app' : ''} ${(prefs.sidebarCollapsed || tourActive) && !studioWindow ? 'sidebar-collapsed' : ''} ${tourActive ? 'tutorial-active' : ''}`}
        style={appearanceStyle(displayAppearance)}
      >
        {!studioWindow && (
          <aside className="sidebar" aria-label="Main navigation">
            <button
              type="button"
              className="sidebar-edge"
              aria-label={prefs.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={prefs.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              onClick={() => prefs.setSidebarCollapsed(!prefs.sidebarCollapsed)}
            />
            <div
              className={`brand ${coneDead ? 'cone-dead' : ''} ${coneAnim !== 'idle' ? `cone-anim-${coneAnim}` : ''}`}
            >
              <button
                className="cone-hitbox"
                aria-label={
                  coneDead
                    ? 'The cone has been defeated'
                    : `${displayAppearance.appName} brand mark`
                }
                title={coneDead ? 'You killed the cone' : 'Cone'}
                onClick={() => void hitCone()}
              >
                {displayAppearance.customIconDataUrl ? (
                  <img
                    className="brand-custom-icon"
                    src={displayAppearance.customIconDataUrl}
                    alt=""
                  />
                ) : (
                  <img src={displayAppearance.themeId === 'ember' ? coneEmber : cone} alt="" />
                )}
                <span className="cone-crack" aria-hidden="true" />
                <span className="cone-ash cone-ash-a" aria-hidden="true" />
                <span className="cone-ash cone-ash-b" aria-hidden="true" />
                <span className="cone-ash cone-ash-c" aria-hidden="true" />
                {coneDead && <span className="dead-eyes">× ×</span>}
              </button>
              <button className="brand-home" onClick={() => navigate('Home')}>
                {displayAppearance.appName.trim() || 'ii Engine'}
                <small>{displayAppearance.tagline.trim() || 'PLAY FURTHER'}</small>
              </button>
            </div>
            <nav aria-label="Primary">
              <p className="nav-label">Play</p>
              {(['Home', ...(canHealth ? ['Health & Repair' as const] : [])] as const).map(
                (name) => {
                  const icon = icons[name];
                  return (
                    <button
                      key={name}
                      title={name}
                      data-tour={name === 'Home' ? 'nav-home' : 'nav-health'}
                      onClick={() => navigate(name)}
                      aria-current={page === name ? 'page' : undefined}
                    >
                      <EngineIcon name={icon} size={18} />
                      <span className="nav-text">{name}</span>
                    </button>
                  );
                },
              )}
              {canModLibrary && (
                <button
                  title="Open Mod Library"
                  aria-label="Mod Library"
                  data-tour="nav-mods"
                  onClick={() => navigate('Autoloader')}
                  aria-current={page === 'Autoloader' ? 'page' : undefined}
                >
                  <EngineIcon name="autoloader" size={18} />
                  <span className="nav-text" aria-hidden="true">
                    Mods
                  </span>
                </button>
              )}
              {canCatalog ? (
                <button
                  title="Catalog"
                  data-tour="nav-catalog"
                  onClick={() => navigate('Catalog')}
                  aria-current={page === 'Catalog' ? 'page' : undefined}
                >
                  <EngineIcon name="list" size={18} />
                  <span className="nav-text">Catalog</span>
                </button>
              ) : null}
              {canCommunityChat && (
                <button
                  title="Community"
                  data-tour="nav-community"
                  onClick={() => navigate('Community')}
                  aria-current={page === 'Community' ? 'page' : undefined}
                  className={prefs.communityMentionUnread ? 'has-unread' : undefined}
                >
                  <EngineIcon name="community" size={18} />
                  <span className="nav-text">
                    Community
                    {prefs.communityMentionUnread && (
                      <span className="nav-unread-dot" aria-label="Unread mention" />
                    )}
                  </span>
                  {prefs.communityMentionUnread && (
                    <span className="nav-unread-dot collapsed-only" aria-hidden="true" />
                  )}
                </button>
              )}
              {(canBackups ? (['Backups'] as const) : []).map((name) => {
                const icon = icons[name];
                return (
                  <button
                    key={name}
                    title={name}
                    onClick={() => navigate(name)}
                    aria-current={page === name ? 'page' : undefined}
                  >
                    <EngineIcon name={icon} size={18} />
                    <span className="nav-text">{name}</span>
                  </button>
                );
              })}
              {(canSeePlayerTracker ||
                canSeeTargetTracker ||
                canSelfTracker ||
                canSeeTrackerScout) && <p className="nav-label">Tracker</p>}
              {canSeePlayerTracker ? (
                <button
                  title="Player Tracker"
                  data-tour="nav-tracker"
                  onClick={() => navigate('Tracker')}
                  aria-current={page === 'Tracker' ? 'page' : undefined}
                >
                  <EngineIcon name="tracker" size={18} />
                  <span className="nav-text">Player Tracker</span>
                </button>
              ) : null}
              {canSeeTargetTracker ? (
                <button
                  title="Target Tracker"
                  data-tour="nav-target-tracker"
                  onClick={() => navigate('Target Tracker')}
                  aria-current={page === 'Target Tracker' ? 'page' : undefined}
                >
                  <EngineIcon name="targetTracker" size={18} />
                  <span className="nav-text">
                    Target Tracker
                    <span className="tiny">BETA</span>
                  </span>
                </button>
              ) : null}
              {canSelfTracker ? (
                <button
                  title="Self Tracker"
                  data-tour="nav-self-tracker"
                  onClick={() => navigate('Self Tracker')}
                  aria-current={page === 'Self Tracker' ? 'page' : undefined}
                >
                  <EngineIcon name="selfTracker" size={18} />
                  <span className="nav-text">Self Tracker</span>
                </button>
              ) : null}
              {canSeeTrackerScout ? (
                <button
                  title="Tracker Scout"
                  data-tour="nav-tracker-scout"
                  onClick={() => navigate('Tracker Scout')}
                  aria-current={page === 'Tracker Scout' ? 'page' : undefined}
                >
                  <EngineIcon name="trackerScout" size={18} />
                  <span className="nav-text">
                    Tracker Scout
                    <span className="tiny">BETA</span>
                  </span>
                </button>
              ) : null}
              {(canStudio || canCustomize || canSoundLab || canDeveloperPanel) && (
                <p className="nav-label">Create</p>
              )}
              {canStudio && (
                <button
                  title="ii Studio"
                  aria-label="ii Studio"
                  data-tour="nav-studio"
                  onClick={() => navigate('ii Studio')}
                  aria-current={page === 'ii Studio' ? 'page' : undefined}
                >
                  <EngineIcon name="studio" size={18} />
                  <span className="nav-text" aria-hidden="true">
                    Studio<span className="tiny">BETA</span>
                  </span>
                </button>
              )}
              {canCustomize && (
                <button
                  title="Customize"
                  onClick={() => navigate('Customize')}
                  aria-current={page === 'Customize' ? 'page' : undefined}
                >
                  <EngineIcon name="customize" size={18} />
                  <span className="nav-text">
                    Customize{isPro ? <span className="tiny">PRO</span> : null}
                  </span>
                </button>
              )}
              {canSoundLab && (
                <button
                  title="ii SoundLab"
                  aria-label="ii SoundLab"
                  onClick={() => navigate('ii SoundLab')}
                  aria-current={page === 'ii SoundLab' ? 'page' : undefined}
                >
                  <EngineIcon name="soundlab" size={18} />
                  <span className="nav-text" aria-hidden="true">
                    SoundLab{isPro ? <span className="tiny">PRO</span> : null}
                  </span>
                </button>
              )}
              {canDeveloperPanel && (
                <button title="Developer" onClick={() => navigate('Staff')}>
                  <EngineIcon name="developer" size={18} />
                  <span className="nav-text">Developer</span>
                </button>
              )}
            </nav>
            <div className="sidebar-bottom">
              <nav className="secondary-nav" aria-label="Account">
                <p className="nav-label">Account</p>
                {canPlans && (
                  <button
                    title="Plans"
                    onClick={() => navigate('Plans')}
                    aria-current={page === 'Plans' ? 'page' : undefined}
                  >
                    <EngineIcon name="plans" size={18} />
                    <span className="nav-text">Plans</span>
                  </button>
                )}
                <button
                  title="Settings"
                  onClick={() => navigate('Settings')}
                  aria-current={page === 'Settings' ? 'page' : undefined}
                >
                  <EngineIcon name="settings" size={18} />
                  <span className="nav-text">Settings</span>
                </button>
              </nav>
              <a
                className="discord-sidebar-card"
                href={official}
                target="_blank"
                rel="noreferrer"
                onClick={externalClick(official)}
              >
                <EngineIcon name="discord" size={20} />
                <span>
                  <strong>Join our Discord</strong>
                  <small>News and support</small>
                </span>
                <EngineIcon name="external" size={14} />
              </a>
              <div className="sidebar-footer">
                <span className="status-dot" /> ii Engine
                <small>v0.2.2 · Beta 2</small>
              </div>
            </div>
          </aside>
        )}
        <div className="workspace">
          {prefs.krakenSession?.active && !studioWindow && (
            <div className="kraken-live-banner" role="status">
              <strong>
                <EngineIcon name="warning" size={16} /> The Kraken is active
              </strong>
              <span>
                Extra mods will be removed when Gorilla Tag closes
                {data?.demo ? ' (demo: end manually)' : ''}.
              </span>
              {(data?.demo || !prefs.krakenSession.gamePath) && (
                <button type="button" onClick={() => prefs.setKrakenSession(null)}>
                  End The Kraken
                </button>
              )}
            </div>
          )}
          {isPro &&
            effectiveAppearance.pageAmbient !== 'none' &&
            !prefs.reduceMotion &&
            page !== 'Tracker' &&
            page !== 'Self Tracker' &&
            page !== 'Target Tracker' &&
            page !== 'Tracker Scout' && <AmbientBackdrop mode={effectiveAppearance.pageAmbient} />}
          <header
            className={`topbar ${studioWindow ? 'studio-window-topbar studio-window-drag-only' : ''}`}
            data-tauri-drag-region
            onMouseDown={dragWindow}
            onDoubleClick={(event) => {
              const target = event.target as HTMLElement;
              if (!target.closest('button, a, input, select, textarea, [role="button"]'))
                windowAction('toggle_maximize_window');
            }}
          >
            <div className="drag-region" data-tauri-drag-region aria-hidden="true" />
            {!studioWindow && (
              <div className="topbar-lead" data-tauri-drag-region>
                <span
                  className={`topbar-status ${launchTone}`}
                  role="status"
                  data-tauri-drag-region
                >
                  <span className="status-dot" />
                  <strong>{connected ? 'Connected' : 'Offline'}</strong>
                  <em>·</em>
                  {launchLine}
                </span>
                <span className="current-page" data-tauri-drag-region>
                  {page === 'Staff'
                    ? 'Developer'
                    : page === 'Autoloader'
                      ? 'Mod Library'
                      : page === 'Community'
                        ? 'Community'
                        : page === 'Catalog'
                          ? 'Catalog'
                          : page === 'Tracker'
                            ? 'Player Tracker'
                            : page === 'Target Tracker'
                              ? 'Target Tracker'
                              : page === 'Self Tracker'
                                ? 'Self Tracker'
                                : page === 'Tracker Scout'
                                  ? 'Tracker Scout'
                                  : page === 'ii SoundLab'
                                    ? 'ii SoundLab'
                                    : page}
                </span>
              </div>
            )}
            <div className="top-actions" data-tauri-drag-region="false">
              {!studioWindow && (
                <div className="notification-control" data-tauri-drag-region="false">
                  <button
                    ref={notificationBtnRef}
                    type="button"
                    className="icon-button"
                    aria-label="Show notifications"
                    aria-expanded={notificationsOpen}
                    data-tauri-drag-region="false"
                    onClick={() => setNotificationsOpen((value) => !value)}
                  >
                    <Bell size={18} />
                    {!!data?.announcements.length && <span className="notification-dot" />}
                  </button>
                  {notificationsOpen &&
                    notificationBox &&
                    createPortal(
                      <div
                        ref={notificationMenuRef}
                        className="notification-menu notification-menu-portal"
                        role="dialog"
                        aria-label="Recent notifications"
                        style={{
                          position: 'fixed',
                          top: notificationBox.top,
                          left: notificationBox.left,
                          width: notificationBox.width,
                          zIndex: 100000,
                        }}
                      >
                        <header>
                          <strong>Recent announcements</strong>
                          <button
                            type="button"
                            onClick={() => {
                              setNotificationsOpen(false);
                              navigate(canCommunityChat ? 'Community' : 'Home');
                            }}
                          >
                            View all
                          </button>
                        </header>
                        {data?.announcements.slice(0, 3).map((item) => (
                          <button
                            type="button"
                            className="notification-item"
                            key={item.id}
                            onClick={() => {
                              setNotificationsOpen(false);
                              navigate(canCommunityChat ? 'Community' : 'Home');
                            }}
                          >
                            {item.avatar ? (
                              <img src={item.avatar} alt="" />
                            ) : (
                              <span className="notification-avatar">
                                <MessageSquare size={18} />
                              </span>
                            )}
                            <span>
                              <strong>{item.author}</strong>
                              <small>{item.text}</small>
                            </span>
                          </button>
                        ))}
                        {!data?.announcements.length && <p>No new announcements.</p>}
                      </div>,
                      document.body,
                    )}
                </div>
              )}
              {isTauri() && (
                <div
                  className="window-controls"
                  aria-label="Window controls"
                  data-tauri-drag-region="false"
                >
                  <button
                    type="button"
                    aria-label="Minimize window"
                    data-tauri-drag-region="false"
                    onClick={(event) => {
                      event.stopPropagation();
                      windowAction('minimize_window');
                    }}
                  >
                    −
                  </button>
                  <button
                    type="button"
                    aria-label="Maximize or restore window"
                    data-tauri-drag-region="false"
                    onClick={(event) => {
                      event.stopPropagation();
                      windowAction('toggle_maximize_window');
                    }}
                  >
                    □
                  </button>
                  <button
                    type="button"
                    className="window-close"
                    aria-label="Close window"
                    data-tauri-drag-region="false"
                    onClick={(event) => {
                      event.stopPropagation();
                      windowAction('close_window');
                    }}
                  >
                    ×
                  </button>
                </div>
              )}
            </div>
          </header>
          <main id="home">
            {membershipCached && data?.member.membership && (
              <div className="membership-cache-banner" role="status">
                <span>Couldn&apos;t verify Discord membership. Using roles saved on this PC.</span>
                <button type="button" disabled={loggingIn} onClick={() => void login()}>
                  {loggingIn ? 'Waiting…' : 'Re-authorize Discord'}
                </button>
              </div>
            )}
            {!canUseApp && !data?.demo ? (
              <section className="panel app-access-blocked">
                <h2>App access is restricted</h2>
                <p>
                  Your Discord roles do not currently include access to ii Engine. Ask a developer
                  if you need the app unlocked.
                </p>
              </section>
            ) : (
              <>
                {!prefs.onboardingComplete && (
                  <FirstRunTutorial
                    finish={finishTour}
                    demo={!!data?.demo}
                    steps={tourSteps}
                    navigate={navigate}
                    onTourActive={handleTourActive}
                  />
                )}
                {query.isPending ? (
                  <div className="empty" role="status">
                    <RefreshCw />
                    Connecting to ii Engine…
                  </div>
                ) : query.isError &&
                  !(query.error instanceof ApiError && query.error.status === 401) ? (
                  <div className="empty connection-unavailable" role="alert">
                    <CircleHelp />
                    <h1>Can't connect right now</h1>
                    <p>
                      {query.error instanceof Error && query.error.message.trim()
                        ? query.error.message
                        : "ii Engine couldn't reach the network. Check your connection and try again."}
                    </p>
                    {(() => {
                      const detail = adminErrorDetail(query.error);
                      const httpFailure = query.error instanceof ApiError && query.error.status > 0;
                      if (!detail) return null;
                      if (!httpFailure && !canStaff) return null;
                      return (
                        <pre className="connection-admin-detail" aria-label="Error detail">
                          {detail}
                        </pre>
                      );
                    })()}
                    <p className="connection-unavailable-hint">
                      If this keeps happening, join Discord for help or try again in a few minutes.
                    </p>
                    <div className="connection-unavailable-actions">
                      <button className="primary" onClick={() => query.refetch()}>
                        Try again
                      </button>
                      <button disabled={loggingIn} onClick={() => void login()}>
                        {loggingIn ? 'Waiting for Discord…' : 'Re-authorize Discord'}
                      </button>
                      <a
                        className="button"
                        href={official}
                        target="_blank"
                        rel="noreferrer"
                        onClick={externalClick(official)}
                      >
                        Get help on Discord
                      </a>
                    </div>
                  </div>
                ) : !signedIn ? (
                  <div className="login">
                    <img src={cone} alt="ii Engine cone mascot" />
                    <span className="eyebrow">II ENGINE</span>
                    <h1>Set up ii Reborn and launch.</h1>
                    <p>Sign in to check your install, get updates, and launch Gorilla Tag.</p>
                    {data?.demo ? (
                      <>
                        <button className="primary" onClick={() => setDemoSignedIn(true)}>
                          Continue <ArrowRight size={18} />
                        </button>
                      </>
                    ) : (
                      <button className="primary" disabled={loggingIn} onClick={login}>
                        {loggingIn ? 'Waiting for Discord…' : 'Sign in with Discord'}
                      </button>
                    )}
                    {loggingIn && (
                      <button onClick={() => loginCancel.current?.abort()}>Cancel sign-in</button>
                    )}
                    {notice && <p role="status">{notice}</p>}
                  </div>
                ) : !data.member.membership ? (
                  membershipSoftChecking || query.isFetching ? (
                    <div className="empty membership-soft-check" aria-busy="true">
                      <RefreshCw className="spin" size={22} />
                      <p role="status">Checking Discord membership…</p>
                    </div>
                  ) : (
                    <div className="empty">
                      <Users />
                      <h1>Couldn&apos;t verify Discord</h1>
                      <p>
                        Engine could not confirm your server roles right now. Re-authorize Discord
                        to refresh membership, or join the official server if you have not yet.
                      </p>
                      <button className="primary" disabled={loggingIn} onClick={() => void login()}>
                        {loggingIn ? 'Waiting for Discord…' : 'Re-authorize Discord'}
                      </button>
                      <a
                        className="button"
                        href={official}
                        target="_blank"
                        rel="noreferrer"
                        onClick={externalClick(official)}
                      >
                        Join Server
                      </a>
                      <button
                        onClick={async () => {
                          try {
                            setMembershipSoftChecking(true);
                            if (!data.demo) await apiRequest('/v1/me/recheck', { method: 'POST' });
                            await query.refetch();
                          } catch (error) {
                            setNotice(String(error));
                          } finally {
                            setMembershipSoftChecking(false);
                          }
                        }}
                      >
                        Recheck Membership
                      </button>
                      {notice && <p role="status">{notice}</p>}
                    </div>
                  )
                ) : (
                  <motion.div
                    className={page === 'ii Studio' ? 'studio-page' : undefined}
                    key={page}
                    initial={pageReveal ? false : false}
                    animate={{ opacity: 1, y: 0 }}
                    transition={
                      pageReveal ? { duration: 0 } : { duration: 0.12, ease: [0.22, 1, 0.36, 1] }
                    }
                  >
                    {page === 'Home' ? (
                      <Home
                        data={data}
                        navigate={navigate}
                        healthStatus={healthStatus}
                        canLaunch={canLaunch}
                        isPro={isPro}
                        hasIiTracker={hasIiTracker}
                        canHomeAi={canHomeAi}
                      />
                    ) : (
                      <>
                        {(['Settings', 'Staff'] as Page[]).includes(page) && (
                          <div className="page-heading">
                            <h1>{page === 'Staff' ? 'Developer' : page}</h1>
                            <p>
                              {
                                (
                                  {
                                    Settings: 'Window behavior, privacy, and account.',
                                    Staff: 'Manage app content and release information.',
                                  } as Record<string, string>
                                )[page]
                              }
                            </p>
                          </div>
                        )}
                        {page === 'Health & Repair' && (
                          <Health
                            demo={data.demo}
                            isPro={isPro}
                            onStatus={setHealthStatus}
                            navigate={canCommunityChat ? navigate : undefined}
                          />
                        )}
                        {page === 'Backups' && <Backups demo={data.demo} />}
                        {page === 'ii Studio' && (
                          <Suspense fallback={<p role="status">Opening ii Studio…</p>}>
                            <Studio demo={data.demo} canLaunch={canLaunch} studioPro={isPro} />
                          </Suspense>
                        )}
                        {page === 'Autoloader' && canModLibrary && (
                          <Suspense fallback={<p role="status">Opening Mod Library…</p>}>
                            <AutoLoader demo={data.demo} isPro={isPro} />
                          </Suspense>
                        )}
                        {page === 'Catalog' && (
                          <Suspense fallback={<p role="status">Opening Catalog…</p>}>
                            <Catalog
                              demo={data.demo}
                              isPro={isPro}
                              onUpgrade={() => navigate('Plans')}
                              onOpenSource={() => navigate('ii Studio')}
                            />
                          </Suspense>
                        )}
                        {page === 'Community' && (
                          <Suspense fallback={<p role="status">Opening Community…</p>}>
                            <Community
                              demo={data.demo}
                              fixtures={data.announcements}
                              isPro={isPro}
                              canStaff={canStaff}
                            />
                          </Suspense>
                        )}
                        {page === 'Self Tracker' && canSelfTracker && (
                          <Suspense fallback={<p role="status">Opening Self Tracker…</p>}>
                            <SelfTracker demo={!!data?.demo} isPro={isPro} navigate={navigate} />
                          </Suspense>
                        )}
                        {page === 'Tracker Scout' && canSeeTrackerScout && (
                          <Suspense fallback={<p role="status">Opening Tracker Scout…</p>}>
                            <TrackerScout hasIiTracker={hasTrackerScout} navigate={navigate} />
                          </Suspense>
                        )}
                        {((page === 'Tracker' && canSeePlayerTracker) ||
                          (page === 'Target Tracker' && canSeeTargetTracker)) && (
                          <Suspense fallback={<p role="status">Opening Tracker…</p>}>
                            <Tracker
                              mode={page === 'Target Tracker' ? 'target' : 'player'}
                              demo={!!data?.demo}
                              isPro={isPro}
                              hasIiTracker={
                                page === 'Target Tracker' ? hasTargetTracker : hasPlayerTracker
                              }
                              hasIiTrackerBeta={hasIiTrackerBeta}
                              isStaff={canStaff}
                              navigate={navigate}
                            />
                          </Suspense>
                        )}
                        {page === 'Plans' && canPlans && (
                          <Suspense fallback={<p role="status">Opening Plans…</p>}>
                            <Plans
                              demo={!!data.demo}
                              isPro={isPro}
                              onOpenTracker={() => navigate('Tracker')}
                              onMembershipRefresh={async () => {
                                if (data?.demo) return;
                                try {
                                  await apiRequest('/v1/me/recheck', { method: 'POST' });
                                  await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
                                  await query.refetch();
                                } catch {}
                              }}
                            />
                          </Suspense>
                        )}
                        {page === 'Customize' && isPro && (
                          <Suspense fallback={<p role="status">Opening Customize…</p>}>
                            <Customize coneKiller={coneKiller} />
                          </Suspense>
                        )}
                        {page === 'ii SoundLab' && isPro && (
                          <Suspense fallback={<p role="status">Opening ii SoundLab…</p>}>
                            <SoundLab isPro={isPro} navigate={navigate} demo={!!data.demo} />
                          </Suspense>
                        )}
                        {page === 'Settings' && (
                          <div className="settings settings-page">
                            <section className="panel settings-group" aria-label="Preferences">
                              <header className="settings-group-head">
                                <h2>Preferences</h2>
                                <p>
                                  Saved locally on this PC. Close to tray and minimize after launch
                                  apply in the desktop app.
                                </p>
                              </header>
                              <div className="settings-rows">
                                {(
                                  [
                                    [
                                      'reduceMotion',
                                      'Reduce motion',
                                      'Cuts animation across the app.',
                                    ],
                                    [
                                      'minimize',
                                      'Minimize after launch',
                                      'Hide the window once Gorilla Tag starts.',
                                    ],
                                    [
                                      'closeToTray',
                                      'Close to tray',
                                      'Keep Engine in the tray instead of quitting.',
                                    ],
                                    [
                                      'anonymousChat',
                                      'Anonymous chat',
                                      'Hide your Discord name, avatar, and role in Community chat.',
                                    ],
                                    [
                                      'studioAiAutocomplete',
                                      'Studio AI autocomplete',
                                      'Uses your daily AI allowance. Completions are hints, not guarantees.',
                                    ],
                                  ] as const
                                ).map(([key, label, hint]) => (
                                  <div className="settings-row" key={key}>
                                    <span className="settings-row-text">
                                      <label htmlFor={`pref-${key}`}>{label}</label>
                                      <small>{hint}</small>
                                    </span>
                                    <input
                                      id={`pref-${key}`}
                                      type="checkbox"
                                      checked={Boolean(prefs[key])}
                                      onChange={(e) => prefs.setPreference(key, e.target.checked)}
                                    />
                                  </div>
                                ))}
                                <div className="settings-row">
                                  <span className="settings-row-text">
                                    <label htmlFor="pref-telemetry">
                                      Share session telemetry with staff
                                    </label>
                                    <small>
                                      Sends your Engine version, platform, feature-usage counts,
                                      in-app AI prompts and replies, and BepInEx log snippets for
                                      debugging, linked to the Discord account you signed in with.
                                      Never your PC name, Windows username, or IP address. The
                                      diagnostics export below is separate and stays on your PC.
                                    </small>
                                  </span>
                                  <input
                                    id="pref-telemetry"
                                    type="checkbox"
                                    checked={prefs.telemetry !== false}
                                    onChange={(e) =>
                                      prefs.setPreference('telemetry', e.target.checked)
                                    }
                                  />
                                </div>
                              </div>
                              <div className="settings-inline-note">
                                <span>
                                  {isPro
                                    ? 'Icon, name, theme, motion, and startup live in Customize.'
                                    : 'Themes, icons, layouts, and motion need Engine Pro.'}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => navigate(isPro ? 'Customize' : 'Plans')}
                                >
                                  {isPro ? 'Open Customize' : 'See Pro'}
                                </button>
                              </div>
                            </section>

                            <section className="panel settings-group" aria-label="Invites">
                              <InviteSettings demo={!!data?.demo} />
                            </section>

                            <section className="panel settings-group" aria-label="Discord account">
                              <header className="settings-group-head">
                                <h2>Discord account</h2>
                                <p>
                                  Signed in as {data.member.display_name}. Disconnect revokes Engine
                                  sessions and removes the cosmetic Engine User role when possible.
                                </p>
                              </header>
                              <div className="settings-actions">
                                <button disabled={accountBusy} onClick={() => void logout()}>
                                  {accountBusy ? 'Working…' : 'Sign out'}
                                </button>
                                {!data.demo && (
                                  <button disabled={accountBusy} onClick={() => void logout(true)}>
                                    Disconnect Discord
                                  </button>
                                )}
                                <button
                                  onClick={async () => {
                                    queryClient.removeQueries({ queryKey: ['dashboard'] });
                                    await query.refetch();
                                    setNotice('Local cache cleared.');
                                  }}
                                >
                                  Clear local cache
                                </button>
                              </div>
                            </section>

                            <section className="panel settings-group" aria-label="Diagnostics">
                              <Diagnostics demo={data.demo} />
                            </section>

                            <section
                              className="panel settings-group settings-danger"
                              aria-label="Danger zone"
                            >
                              <header className="settings-group-head">
                                <h2>Danger zone</h2>
                                <p>These actions cannot be undone from inside the app.</p>
                              </header>
                              {!data.demo && (
                                <div className="danger-zone">
                                  <h3>Delete Engine account</h3>
                                  <p>
                                    This permanently erases your ii Engine account, sessions, usage
                                    counters, developer access record, and role-grant record. It
                                    does not delete your Discord account or local backups.
                                  </p>
                                  {!deleteArmed ? (
                                    <button onClick={() => setDeleteArmed(true)}>
                                      Review account deletion
                                    </button>
                                  ) : (
                                    <div className="developer-toolbar">
                                      <button onClick={() => setDeleteArmed(false)}>Cancel</button>
                                      <button
                                        className="danger-button"
                                        onClick={async () => {
                                          try {
                                            const result = await deleteAccount();
                                            queryClient.clear();
                                            setEntered(false);
                                            setNotice(result.message);
                                          } catch (error) {
                                            setNotice(String(error));
                                          } finally {
                                            setDeleteArmed(false);
                                          }
                                        }}
                                      >
                                        Permanently delete my account
                                      </button>
                                    </div>
                                  )}
                                </div>
                              )}
                              <div className="danger-zone">
                                <h3>Uninstall ii Engine</h3>
                                <p>
                                  Removes the ii Engine app from this PC. Your Discord account and
                                  Gorilla Tag install stay put. Local preferences may remain until
                                  you clear them in Windows.
                                </p>
                                {!uninstallArmed ? (
                                  <button
                                    type="button"
                                    onClick={() => setUninstallArmed(true)}
                                    disabled={uninstallBusy}
                                  >
                                    Uninstall ii Engine…
                                  </button>
                                ) : (
                                  <div className="developer-toolbar">
                                    <button
                                      type="button"
                                      onClick={() => setUninstallArmed(false)}
                                      disabled={uninstallBusy}
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      className="danger-button"
                                      disabled={uninstallBusy}
                                      onClick={() => void uninstallEngine()}
                                    >
                                      {uninstallBusy ? 'Opening…' : 'Open uninstaller'}
                                    </button>
                                  </div>
                                )}
                              </div>
                            </section>

                            <Suspense fallback={<p role="status">Loading documents…</p>}>
                              <Legal />
                            </Suspense>
                          </div>
                        )}
                        {page === 'Staff' && (
                          <Developer demo={data.demo} canPlanToggle={canPlanToggle} isPro={isPro} />
                        )}
                      </>
                    )}
                    {notice && (
                      <div className="callout" role="status">
                        {notice}
                      </div>
                    )}
                    {page !== 'ii Studio' &&
                      page !== 'Tracker' &&
                      page !== 'Self Tracker' &&
                      page !== 'Target Tracker' &&
                      page !== 'Tracker Scout' && (
                        <footer className="main-footer">
                          <span>Made for the ii community.</span>
                          <span>
                            Follow current Gorilla Tag and server rules.{' '}
                            <a
                              href="https://github.com/iireborn/menu"
                              target="_blank"
                              rel="noreferrer"
                              onClick={externalClick('https://github.com/iireborn/menu')}
                            >
                              Source <ExternalLink size={12} />
                            </a>
                          </span>
                        </footer>
                      )}
                  </motion.div>
                )}
              </>
            )}
          </main>
        </div>
        {pageReveal && (
          <PageRevealGrid
            key={pageRevealGen}
            phase={pageReveal}
            coverMs={
              gridPageRevealTiming[effectiveAppearance.gridPageRevealSpeed ?? 'normal'].coverMs
            }
            revealMs={
              gridPageRevealTiming[effectiveAppearance.gridPageRevealSpeed ?? 'normal'].revealMs
            }
            onCoverComplete={onCoverComplete}
            onRevealComplete={finishPageReveal}
          />
        )}
      </div>
      {coneRoleToast &&
        createPortal(
          <div className="cone-role-toast" role="status" aria-live="assertive">
            <div className="cone-role-toast-mark" aria-hidden="true">
              <img src={cone} alt="" />
            </div>
            <div className="cone-role-toast-copy">
              <strong>{coneRoleToast.title}</strong>
              <span>{coneRoleToast.body}</span>
            </div>
            <button type="button" className="text-button" onClick={() => setConeRoleToast(null)}>
              Dismiss
            </button>
          </div>,
          document.body,
        )}
    </MotionConfig>
  );
}
