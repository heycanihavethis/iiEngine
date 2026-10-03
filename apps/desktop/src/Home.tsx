import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Dashboard } from '../../../packages/contracts/dashboard';
import type { Page } from './store';
import { EngineIcon, type EngineIconName } from './EngineIcon';
import ManagedContent from './ManagedContent';
import {
  appendSessionBepInEx,
  recordAiTranscript,
  reportEngineError,
  trackFeature,
} from './telemetry';
import { ApiError, apiRequest, errorMessage } from './api';
import {
  applyMenuUpdate,
  checkMenuUpdateStatus,
  detectGame,
  ensureInstallationForLaunch,
  getMenuReleases,
  scanInstallation,
  selectedRelease,
  tryDetectGame,
  type HealthReport,
  type MenuUpdateStatus,
} from './launcher';
import { readMenuCatalogCache } from './menuCatalogCache';
import { syncMenuBridge } from './menuBridge';
import { usePreferences } from './store';
import { CustomSelect } from './CustomSelect';
import { externalClick } from './external';
import { KRAKEN_CONFIRM_PHRASE, runKrakenMode } from './kraken';
import { createDesktopKrakenDeps } from './krakenDesktop';
import {
  defaultAppearance,
  homeWidgetCatalog,
  homeWidgetLabels,
  homeWidgetBlurbs,
  homeWidgetZoneLabels,
  moveHomeWidgetToZone,
  setHomeWidgetSize,
  setHomeWidgetVisible,
  type HomeWidget,
  type HomeWidgetId,
  type HomeWidgetSize,
  type HomeWidgetZone,
  type LaunchHeroSize,
} from './appearance';
import BackgroundMusic from './BackgroundMusic';
import { useMusicStore } from './musicStore';
import AiModChecker from './AiModChecker';
import AntivirusLockHelp from './AntivirusLockHelp';
import { isAntivirusLockError } from './antivirusHelp';
import { homeBackgroundUrl } from './homeBackgrounds';
import { CONE_KILLER_ROLE_ID, resolveMemberBadge } from './featureAccess';
import { readLoadouts } from './loadouts';
import HomeTrackerPills from './HomeTrackerPills';

type PublicOperations = {
  countdown: { enabled: boolean; title: string; target_at: string | null };
  menu: { status: 'operational' | 'degraded' | 'maintenance' | 'offline'; message: string };
};

const official = 'https://discord.gg/iidk';

function demoAssistantAnswer(question: string) {
  if (/\b(staff|owner|admin|dev|moderator|king|drifted|useless|doggo|lucy|tag)\b/i.test(question)) {
    return 'King is Owner. Drifted is Head Admin and built ii Engine. Useless is Head Dev. Tag and Lucy are Devs. Doggo is Moderator.';
  }
  if (/\b(engine|plans?|pro|tracker|soundlab|robux)\b/i.test(question)) {
    return 'ii Engine launches Gorilla Tag with ii Reborn Menu. Engine Pro adds AI, SoundLab, Tracker presence sharing, Customize, Studio Pro, and Discord perks. Plans: $7/mo, $14 lifetime, $25 lifetime + Tracker pack, or 2500 Robux.';
  }
  return 'From the ii Reborn Menu catalog, try Platforms, Fly [A], Iron Man, Speed Boost, Ghost [A], or Frozone. Browse Movement / Visual / Fun tabs in-menu. I only suggest published titles.';
}

export default function Home({
  data,
  navigate,
  healthStatus,
  canLaunch,
  isPro,
  hasIiTracker = false,
  canHomeAi = false,
}: {
  data: Dashboard;
  navigate: (page: Page) => void;
  healthStatus: string;
  canLaunch: boolean;
  isPro: boolean;
  hasIiTracker?: boolean;
  canHomeAi?: boolean;
}) {
  const [options, setOptions] = useState(false);
  const [launchMenuBox, setLaunchMenuBox] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [launchStatus, setLaunchStatus] = useState('');
  const [launchError, setLaunchError] = useState('');
  const [launching, setLaunching] = useState(false);
  const [updatingMenu, setUpdatingMenu] = useState(false);
  const [menuUpdate, setMenuUpdate] = useState<MenuUpdateStatus | null>(null);
  const [scanStage, setScanStage] = useState('');
  const [installReport, setInstallReport] = useState<HealthReport | null>(null);
  const [installLookupError, setInstallLookupError] = useState('');
  const [gamePath, setGamePath] = useState('');
  const [logEnabled, setLogEnabled] = useState(false);
  const [logText, setLogText] = useState('');
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [assistQuestion, setAssistQuestion] = useState('');
  const [assistTurn, setAssistTurn] = useState<{
    question: string;
    answer: string;
  } | null>(() => {
    try {
      localStorage.removeItem('ii-engine-home-assist-thread');
      sessionStorage.removeItem('ii-engine-home-assist-turn');
    } catch {}
    return null;
  });
  const [assistBusy, setAssistBusy] = useState(false);
  const [assistError, setAssistError] = useState('');
  const [assistRemaining, setAssistRemaining] = useState<number | null>(null);
  const [krakenConfirmOpen, setKrakenConfirmOpen] = useState(false);
  const [krakenPhrase, setKrakenPhrase] = useState('');
  const [krakenAckMalice, setKrakenAckMalice] = useState(false);
  const [krakenAckStability, setKrakenAckStability] = useState(false);
  const [loadoutTick, setLoadoutTick] = useState(0);
  const logOffset = useRef(0);
  const logEnd = useRef<HTMLPreElement | null>(null);
  const launchMenuRef = useRef<HTMLDivElement | null>(null);
  const launchOptionsBtnRef = useRef<HTMLButtonElement | null>(null);
  const launchMenuPanelRef = useRef<HTMLDivElement | null>(null);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const holdTimer = useRef<number | null>(null);
  const pressRef = useRef<{
    id: HomeWidgetId;
    y: number;
    slot: HTMLElement;
    pointerId: number;
  } | null>(null);
  const dragRef = useRef<{
    id: HomeWidgetId;
    offsetY: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const [liftId, setLiftId] = useState<HomeWidgetId | null>(null);
  const [liftBox, setLiftBox] = useState({ top: 0, left: 0, width: 0 });
  const [editMode, setEditMode] = useState(false);
  const editModeRef = useRef(false);
  const preferences = usePreferences();
  const homeWidgets = (
    isPro ? preferences.appearance.homeWidgets : defaultAppearance.homeWidgets
  ).filter(
    (widget) =>
      (widget.id !== 'loadouts' || isPro) &&
      (widget.id !== 'tracker' || hasIiTracker) &&
      (widget.id !== 'music' || isPro) &&
      (widget.id !== 'assistant' || canHomeAi),
  );
  const launchHeroSize: LaunchHeroSize = isPro
    ? preferences.appearance.launchHeroSize === 'compact'
      ? 'compact'
      : 'regular'
    : 'regular';
  const coneKiller = data.demo || data.member.roles.some((role) => role.id === CONE_KILLER_ROLE_ID);
  const rawHomeBackgroundId = isPro
    ? preferences.appearance.homeBackgroundId
    : defaultAppearance.homeBackgroundId;
  const homeBackgroundId =
    rawHomeBackgroundId === 'cat' && !coneKiller ? 'none' : rawHomeBackgroundId;
  const homeBackgroundSrc = homeBackgroundUrl(homeBackgroundId);
  const homeBackgroundBlur = isPro && preferences.appearance.homeBackgroundBlur;
  const homeBackgroundBlurIntensity = preferences.appearance.homeBackgroundBlurIntensity;
  useEffect(() => {
    if (isPro) return;
    const store = useMusicStore.getState();
    if (store.playing) store.togglePlay();
  }, [isPro]);
  const memberBadge = resolveMemberBadge(
    data.member.roles.map((role) => role.id),
    data.member.entitlements,
  );
  const releases = useQuery({
    queryKey: ['menu-releases'],
    queryFn: getMenuReleases,
    enabled: !data.demo,
    retry: 1,
    staleTime: 30_000,
    placeholderData: () => readMenuCatalogCache() ?? undefined,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });
  const chosen = selectedRelease(releases.data, preferences.selectedReleaseId);
  useEffect(() => {
    if (data.demo || !isTauri()) {
      setMenuUpdate(null);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const status = await checkMenuUpdateStatus();
        if (!cancelled) setMenuUpdate(status);
      } catch {
        if (!cancelled) setMenuUpdate(null);
      }
    };
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [data.demo, releases.dataUpdatedAt]);
  const operations = useQuery({
    queryKey: ['platform-operations'],
    queryFn: async () => {
      try {
        const value = await (await apiRequest('/v1/platform/operations')).json();
        if (!value?.countdown || !value?.menu) return null;
        return value as PublicOperations;
      } catch {
        return null;
      }
    },
    enabled: !data.demo,
    retry: false,
    refetchInterval: 60_000,
  });
  const weeklyPicks = useQuery({
    queryKey: ['weekly-mod-picks', data.demo],
    queryFn: async () => {
      if (data.demo) {
        return {
          items: [
            {
              id: 'demo-1',
              name: 'Platforms Pack',
              description: 'Starter movement utility for casual lobbies.',
              target_type: 'trusted',
              score: 12,
            },
            {
              id: 'demo-2',
              name: 'Name Tags+',
              description: 'Clean nameplates without heavy ESP.',
              target_type: 'trusted',
              score: 9,
            },
            {
              id: 'demo-3',
              name: 'Lobby Tools',
              description: 'Community favorite for room utilities.',
              target_type: 'community',
              score: 7,
            },
          ],
        };
      }
      const response = await apiRequest('/v1/mods/weekly-picks');
      return (await response.json()) as {
        items: {
          id: string;
          name: string;
          description: string;
          target_type: string;
          score: number;
        }[];
      };
    },
    retry: false,
    refetchInterval: 300_000,
  });
  const loadouts = readLoadouts();
  void loadoutTick;
  const memberEntitlementsKey = data.member.entitlements.join(',');
  useEffect(() => {
    if (!operations.data?.countdown?.enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [operations.data?.countdown?.enabled]);
  useEffect(() => {
    if (data.demo || !isTauri()) return;
    let active = true;
    void (async () => {
      const game = await tryDetectGame();
      if (!active) return;
      if (!game) {
        setInstallLookupError('');
        return;
      }
      setGamePath(game);
      try {
        const report = await scanInstallation(game);
        if (active) setInstallReport(report);
        await syncMenuBridge(game);
      } catch {
        if (active) setInstallLookupError('');
      }
    })();
    return () => {
      active = false;
    };
  }, [data.demo]);

  useEffect(() => {
    if (data.demo || !isTauri() || !gamePath) return;
    void syncMenuBridge(gamePath).catch(() => {});
  }, [data.demo, gamePath, memberEntitlementsKey]);

  useEffect(() => {
    if (preferences.krakenSession?.active) return;
    setLaunchStatus((current) => (/Kraken/i.test(current) ? '' : current));
  }, [preferences.krakenSession?.active]);

  useEffect(() => {
    if (!logEnabled || !gamePath || data.demo || !isTauri()) return;
    let stopped = false;
    const poll = async () => {
      try {
        const chunk = await invoke<{ offset: number; text: string; reset: boolean }>(
          'studio_read_log',
          { gamePath, offset: logOffset.current },
        );
        if (stopped) return;
        logOffset.current = chunk.offset;
        if (chunk.reset) {
          setLogText(chunk.text);
          appendSessionBepInEx(chunk.text, gamePath);
        } else if (chunk.text) {
          setLogText((current) => (current + chunk.text).slice(-120_000));
          appendSessionBepInEx(chunk.text, gamePath);
        }
      } catch {}
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 900);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [data.demo, gamePath, logEnabled]);

  async function askViaChatFallback(question: string) {
    const response = await apiRequest('/v1/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `ii Reborn Menu / Gorilla Tag help: ${question}`,
        share_telemetry: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await response.text();
    const pieces: string[] = [];
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const payload = JSON.parse(line.slice(5).trim()) as {
          text?: string;
          remaining?: number;
          message?: string;
        };
        if (payload.text) pieces.push(payload.text);
        if (typeof payload.remaining === 'number') setAssistRemaining(payload.remaining);
        if (payload.message) throw new Error(payload.message);
      } catch (error) {
        if (error instanceof Error && error.message && !error.message.includes('JSON')) throw error;
      }
    }
    const answer = pieces.join('').trim();
    if (!answer) throw new Error('No answer returned.');
    return answer;
  }

  function rememberAssistTurn(question: string, answer: string) {
    try {
      localStorage.removeItem('ii-engine-home-assist-thread');
      sessionStorage.removeItem('ii-engine-home-assist-turn');
    } catch {}
    setAssistTurn({ question, answer });
  }

  async function askHomeAssistant(event?: FormEvent) {
    event?.preventDefault();
    const question = assistQuestion.trim();
    if (!question || assistBusy) return;
    setAssistError('');
    if (data.demo) {
      rememberAssistTurn(question, demoAssistantAnswer(question));
      setAssistQuestion('');
      setAssistBusy(true);
      try {
        const response = await fetch('/v1/ai/home-assistant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: question }),
          signal: AbortSignal.timeout(8_000),
        });
        if (response.ok) {
          const payload = (await response.json()) as {
            answer?: unknown;
            remaining?: number;
          };
          const apiAnswer = typeof payload.answer === 'string' ? payload.answer.trim() : '';
          if (apiAnswer) rememberAssistTurn(question, apiAnswer);
          if (typeof payload.remaining === 'number') setAssistRemaining(payload.remaining);
        }
      } catch {
      } finally {
        setAssistBusy(false);
      }
      return;
    }
    setAssistBusy(true);
    try {
      let answer = '';
      try {
        const response = await apiRequest('/v1/ai/home-assistant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: question,
            share_telemetry: false,
          }),
          signal: AbortSignal.timeout(60_000),
        });
        const payload = (await response.json()) as {
          answer?: string;
          remaining?: number;
        };
        answer = payload.answer?.trim() || '';
        setAssistRemaining(typeof payload.remaining === 'number' ? payload.remaining : null);
      } catch (reason) {
        if (!(reason instanceof ApiError) || reason.status !== 404) throw reason;
        answer = await askViaChatFallback(question);
      }
      if (!answer) throw new Error('No answer returned.');
      rememberAssistTurn(question, answer);
      setAssistQuestion('');
      recordAiTranscript('home', question, answer);
      trackFeature('ai_home', 'ask');
    } catch (reason) {
      const msg = errorMessage(reason, 'Assistant is temporarily unavailable.');
      setAssistError(msg);
      reportEngineError({ feature: 'ai_home', message: msg });
    } finally {
      setAssistBusy(false);
    }
  }
  useEffect(() => {
    const node = logEnd.current;
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'end' });
    }
  }, [logText]);

  useLayoutEffect(() => {
    if (!options || !launchOptionsBtnRef.current) {
      setLaunchMenuBox(null);
      return;
    }
    const place = () => {
      const rect = launchOptionsBtnRef.current!.getBoundingClientRect();
      const buttons = launchMenuRef.current?.getBoundingClientRect();
      const width = Math.max(buttons?.width ?? 280, 280);
      const left = Math.min(Math.max(8, buttons?.left ?? rect.left), window.innerWidth - width - 8);
      setLaunchMenuBox({
        top: rect.bottom + 6,
        left,
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
  }, [options]);

  useEffect(() => {
    if (!options) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (launchMenuRef.current?.contains(target)) return;
      if (launchMenuPanelRef.current?.contains(target)) return;
      setOptions(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOptions(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [options]);
  const target = operations.data?.countdown?.target_at
    ? new Date(operations.data.countdown.target_at).getTime()
    : 0;
  const remaining = Math.max(0, target - now);
  const countdown = `${Math.floor(remaining / 86400000)}d ${Math.floor((remaining % 86400000) / 3600000)}h ${Math.floor((remaining % 3600000) / 60000)}m ${Math.floor((remaining % 60000) / 1000)}s`;
  const gameCheck = installReport?.checks.find((check) => check.name === 'Game installation');
  const loaderCheck = installReport?.checks.find((check) => check.name === 'Loader version');
  const gameState = data.demo
    ? 'Ready'
    : installReport
      ? gameCheck?.status === 'Healthy'
        ? 'Working'
        : 'Not found'
      : installLookupError
        ? 'Not found'
        : 'Checking…';
  const bepinexState = data.demo
    ? 'Ready'
    : installReport
      ? loaderCheck?.status === 'Healthy'
        ? 'Working'
        : loaderCheck
          ? 'Old release'
          : 'Not found'
      : installLookupError
        ? 'Not found'
        : 'Checking…';
  const installReady = gameState === 'Working' && bepinexState === 'Working';
  const engineVersion = chosen?.version ?? data.release.version ?? '1.0.3';
  const menuCheck = installReport?.checks.find((check) => check.name === 'Menu copies');
  const pluginIssues =
    installReport?.checks.filter(
      (check) =>
        check.name.startsWith('BepInEx/plugins') &&
        (check.status === 'Error' || check.status === 'Warning') &&
        !/unknown dll/i.test(check.detail) &&
        check.name !== 'Extra plugins',
    ).length ?? 0;
  const scanning = !data.demo && !installReport && !installLookupError;
  const accountRows: {
    label: string;
    value: string;
    ok: boolean;
    icon: EngineIconName;
  }[] = [
    {
      label: 'Gorilla Tag',
      value: data.demo ? 'Working' : gameState,
      ok: data.demo || gameState === 'Working',
      icon: 'play',
    },
    {
      label: 'BepInEx',
      value: data.demo ? 'Working' : bepinexState,
      ok: data.demo || bepinexState === 'Working',
      icon: 'puzzle',
    },
    {
      label: 'ii Menu',
      value:
        installReady || data.demo
          ? `Up to date (${engineVersion})`
          : `Not verified (${engineVersion})`,
      ok: installReady || data.demo,
      icon: 'settings',
    },
  ];
  const healthRows = [
    { label: 'Game files', ok: data.demo || gameCheck?.status === 'Healthy' },
    { label: 'BepInEx', ok: data.demo || loaderCheck?.status === 'Healthy' },
    { label: 'ii Menu', ok: data.demo || menuCheck?.status === 'Healthy' },
    {
      label: 'Installed mods',
      ok: data.demo || (!!installReport && pluginIssues === 0),
    },
  ].map((row) => ({
    ...row,
    value: scanning
      ? 'Checking…'
      : row.label === 'Installed mods' && row.ok && !data.demo
        ? 'OK (extras ignored)'
        : row.ok
          ? 'Healthy'
          : 'Needs repair',
  }));
  const allHealthy = healthRows.every((row) => row.ok);
  const healthVerdict = scanning
    ? 'Checking your installation…'
    : allHealthy
      ? 'Everything looks good!'
      : 'Run Health & Repair to fix this.';

  async function runLauncher(play: boolean) {
    if (play && !canLaunch) {
      setLaunchError('Your Discord roles do not currently include game launching access.');
      return;
    }
    if (data.demo || !isTauri()) {
      setLaunchError('Installation and launch checks require the Windows desktop app.');
      if (play) {
        setLogText(
          'BepInEx runtime logs stream here after you Launch with ii Menu on the desktop app.\n',
        );
        setLogEnabled(true);
        setConsoleOpen(true);
      }
      return;
    }
    setLaunching(true);
    setLaunchError('');
    const stages = [
      'Locating Gorilla Tag',
      'Checking game executable',
      'Inspecting BepInEx loader',
      'Reading installed plugins',
      'Comparing menu release',
      'Verifying file checksums',
      'Checking launch readiness',
    ];
    let stageIndex = 0;
    setScanStage(stages[0]);
    const stageTimer = window.setInterval(() => {
      stageIndex = Math.min(stageIndex + 1, stages.length - 1);
      setScanStage(stages[stageIndex]);
    }, 120);
    try {
      const result = await ensureInstallationForLaunch(chosen, setLaunchStatus);
      if (result.gamePath) setGamePath(result.gamePath);
      if (result.updateAvailable) {
        setMenuUpdate((prev) =>
          prev ? { ...prev, updateAvailable: true, ready: false, missing: false } : prev,
        );
      }
      if (play) {
        setLaunchStatus(
          result.updateAvailable
            ? 'ii Menu update available. Launching with your current install…'
            : result.unverified
              ? "Couldn't verify installation. Launching with your current ii menu…"
              : 'Installation verified. Asking Steam to launch Gorilla Tag…',
        );
        try {
          await syncMenuBridge(result.gamePath);
        } catch {}
        await invoke('launch_game', { gamePath: result.gamePath });
        trackFeature(
          'launch_game',
          result.updateAvailable ? 'home_outdated' : result.unverified ? 'home_unverified' : 'home',
        );
        setLaunchStatus(
          result.updateAvailable
            ? 'Launched with ii. Update available — click Update ii Menu when ready.'
            : result.unverified
              ? "Launched with ii. Couldn't verify installation."
              : result.changed
                ? 'Updated and launched with ii.'
                : 'Verified and launched with ii.',
        );
        logOffset.current = 0;
        setLogText('Waiting for BepInEx LogOutput.log…\n');
        setLogEnabled(true);
        setConsoleOpen(true);
      } else {
        setLaunchStatus(
          result.updateAvailable
            ? 'ii Menu update available. Click Update ii Menu when you are ready.'
            : result.unverified
              ? "Couldn't verify installation. Using the ii menu already on this PC."
              : result.changed
                ? 'Updated · installation repaired.'
                : 'Healthy.',
        );
      }
    } catch (reason) {
      setLaunchStatus('');
      const msg = reason instanceof Error ? reason.message : String(reason);
      setLaunchError(msg);
      void reportEngineError({ feature: 'launch_game', message: msg });
    } finally {
      window.clearInterval(stageTimer);
      setScanStage('');
      setLaunching(false);
    }
  }

  async function runMenuUpdate() {
    if (data.demo || !isTauri()) {
      setLaunchError('Menu updates require the Windows desktop app.');
      return;
    }
    setUpdatingMenu(true);
    setLaunchError('');
    setLaunchStatus('');
    try {
      const result = await applyMenuUpdate(chosen, setLaunchStatus);
      if (result.gamePath) setGamePath(result.gamePath);
      const status = await checkMenuUpdateStatus();
      setMenuUpdate(status);
      await releases.refetch();
      setLaunchStatus(
        result.unverified
          ? `ii Menu ${chosen?.version ?? status.release?.version ?? ''} installed. Verification was soft — you can still Launch.`
          : `ii Menu ${chosen?.version ?? status.release?.version ?? ''} is installed and ready.`,
      );
      trackFeature('menu_update', result.changed ? 'applied' : 'already_ready');
    } catch (reason) {
      setLaunchStatus('');
      const msg = reason instanceof Error ? reason.message : String(reason);
      setLaunchError(msg);
      void reportEngineError({ feature: 'menu_update', message: msg });
    } finally {
      setUpdatingMenu(false);
    }
  }

  async function playWithoutIi() {
    if (!canLaunch) {
      setLaunchError('Your Discord roles do not currently include game launching access.');
      return;
    }
    setLaunching(true);
    setLaunchError('');
    try {
      const gamePath = await detectGame();
      await invoke('launch_without_ii', { gamePath });
      setLaunchStatus('Gorilla Tag launched without the ii menu. Launch with ii to restore it.');
      setOptions(false);
    } catch (reason) {
      setLaunchError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLaunching(false);
    }
  }

  async function playWithCurrentSetup() {
    if (!canLaunch) {
      setLaunchError('Your Discord roles do not currently include game launching access.');
      return;
    }
    if (data.demo || !isTauri()) {
      setLaunchError('Launch requires the Windows desktop app.');
      return;
    }
    setLaunching(true);
    setLaunchError('');
    try {
      const path = await detectGame();
      if (path) setGamePath(path);
      setLaunchStatus('Launching Gorilla Tag with your current setup…');
      await invoke('launch_game', { gamePath: path });
      trackFeature('launch_game', 'current_setup');
      setLaunchStatus('Launched with current setup. Nothing was updated or disabled.');
      setOptions(false);
    } catch (reason) {
      setLaunchStatus('');
      setLaunchError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLaunching(false);
    }
  }

  function resetKrakenConfirm() {
    setKrakenConfirmOpen(false);
    setKrakenPhrase('');
    setKrakenAckMalice(false);
    setKrakenAckStability(false);
  }

  const krakenReady =
    krakenAckMalice &&
    krakenAckStability &&
    krakenPhrase.trim().toUpperCase() === KRAKEN_CONFIRM_PHRASE;

  async function runTheKraken() {
    if (!canLaunch) {
      setLaunchError('Your Discord roles do not currently include game launching access.');
      return;
    }
    if (!krakenReady) return;
    resetKrakenConfirm();
    setOptions(false);
    if (data.demo || !isTauri()) {
      preferences.setKrakenSession({
        active: true,
        gamePath: '',
        preservedPaths: [],
        addedPaths: [],
        launchedAt: Date.now(),
      });
      setLaunchStatus(
        'The Kraken is active for this demo. Closing ends it. Installing every mod and launching requires the Windows desktop app.',
      );
      setLaunchError('');
      trackFeature('launch_game', 'kraken_demo');
      return;
    }
    setLaunching(true);
    setLaunchError('');
    setLaunchStatus('Releasing The Kraken…');
    preferences.setKrakenSession({
      active: true,
      gamePath: '',
      preservedPaths: [],
      addedPaths: [],
      launchedAt: Date.now(),
    });
    try {
      await runKrakenMode(createDesktopKrakenDeps(chosen), setLaunchStatus, {
        onSession: (session) => preferences.setKrakenSession(session.active ? session : null),
      });
      trackFeature('launch_game', 'kraken');
      preferences.setKrakenSession(null);
    } catch (reason) {
      preferences.setKrakenSession(null);
      setLaunchStatus('');
      setLaunchError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLaunching(false);
    }
  }

  function clearHold() {
    if (holdTimer.current != null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }

  function exitEditMode() {
    clearHold();
    pressRef.current = null;
    dragRef.current = null;
    setLiftId(null);
    editModeRef.current = false;
    setEditMode(false);
  }

  useEffect(() => {
    editModeRef.current = editMode;
  }, [editMode]);

  function beginLift(id: HomeWidgetId, slot: HTMLElement, clientY: number, pointerId: number) {
    const rect = slot.getBoundingClientRect();
    dragRef.current = {
      id,
      offsetY: clientY - rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
    editModeRef.current = true;
    setEditMode(true);
    setLiftId(id);
    setLiftBox({ top: rect.top, left: rect.left, width: rect.width });
    try {
      stackRef.current?.setPointerCapture(pointerId);
    } catch {}
  }

  function dropTarget(
    clientX: number,
    clientY: number,
  ): {
    zone: HomeWidgetZone;
    index: number;
  } {
    const zones = (['main', 'rail', 'below'] as HomeWidgetZone[])
      .map((zone) => {
        const el = stackRef.current?.querySelector<HTMLElement>(`[data-home-zone="${zone}"]`);
        return el ? { zone, el } : null;
      })
      .filter(Boolean) as { zone: HomeWidgetZone; el: HTMLElement }[];

    let best = zones[0] ?? { zone: 'main' as HomeWidgetZone, el: stackRef.current! };
    let bestDist = Number.POSITIVE_INFINITY;
    for (const entry of zones) {
      const rect = entry.el.getBoundingClientRect();
      const cx = Math.min(Math.max(clientX, rect.left), rect.right);
      const cy = Math.min(Math.max(clientY, rect.top), rect.bottom);
      const dist = (clientX - cx) ** 2 + (clientY - cy) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = entry;
      }
    }

    const list = [...best.el.querySelectorAll<HTMLElement>(':scope > [data-home-widget]')];
    let index = list.length;
    list.forEach((slot, i) => {
      const rect = slot.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2 && index === list.length) index = i;
    });
    return { zone: best.zone, index };
  }

  function onArrangeDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!isPro || event.button !== 0 || liftId) return;
    const target = event.target as HTMLElement;
    if (
      target.closest(
        '[data-home-widget-ignore], .home-widget-remove, .home-widget-dock, .home-edit-toolbar, .home-widget-size',
      )
    )
      return;
    if (target.closest('input, textarea, select, label, summary, [role="slider"]')) return;
    const control = target.closest('button, a');
    if (
      control &&
      !control.closest('.home-shortcut-pill') &&
      !control.classList.contains('action-tile') &&
      !control.closest('.action-tile')
    ) {
      return;
    }
    const slot = target.closest<HTMLElement>('[data-home-widget]');
    if (!slot) return;
    const id = slot.dataset.homeWidget as HomeWidgetId;
    pressRef.current = { id, y: event.clientY, slot, pointerId: event.pointerId };
    clearHold();
    const delay = editModeRef.current ? 60 : 380;
    const pointerId = event.pointerId;
    holdTimer.current = window.setTimeout(() => {
      const press = pressRef.current;
      if (!press || press.pointerId !== pointerId) return;
      beginLift(press.id, press.slot, press.y, press.pointerId);
    }, delay);
  }

  function onArrangeMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (pressRef.current && !dragRef.current) {
      pressRef.current.y = event.clientY;
    }
    const drag = dragRef.current;
    if (!drag) return;
    setLiftBox({
      top: event.clientY - drag.offsetY,
      left: Math.max(
        12,
        Math.min(event.clientX - drag.width / 2, window.innerWidth - drag.width - 12),
      ),
      width: drag.width,
    });
    const target = dropTarget(event.clientX, event.clientY);
    preferences.setAppearance({
      homeWidgets: moveHomeWidgetToZone(
        preferences.appearance.homeWidgets,
        drag.id,
        target.zone,
        target.index,
      ),
    });
  }

  function onArrangeUp(event: ReactPointerEvent<HTMLDivElement>) {
    clearHold();
    pressRef.current = null;
    if (stackRef.current?.hasPointerCapture?.(event.pointerId)) {
      try {
        stackRef.current.releasePointerCapture(event.pointerId);
      } catch {}
    }
    if (!dragRef.current) return;
    dragRef.current = null;
    setLiftId(null);
  }

  function removeHomeWidget(id: HomeWidgetId) {
    preferences.setAppearance({
      homeWidgets: setHomeWidgetVisible(preferences.appearance.homeWidgets, id, false),
    });
  }

  function addHomeWidget(id: HomeWidgetId) {
    preferences.setAppearance({
      homeWidgets: setHomeWidgetVisible(preferences.appearance.homeWidgets, id, true),
    });
  }

  function toggleWidgetSize(id: HomeWidgetId) {
    const current = homeWidgets.find((widget) => widget.id === id);
    if (!current) return;
    const next: HomeWidgetSize = current.size === 'compact' ? 'regular' : 'compact';
    preferences.setAppearance({
      homeWidgets: setHomeWidgetSize(preferences.appearance.homeWidgets, id, next),
    });
  }

  function toggleLaunchHeroSize() {
    if (!isPro) return;
    const next: LaunchHeroSize = launchHeroSize === 'compact' ? 'regular' : 'compact';
    preferences.setAppearance({ launchHeroSize: next });
  }

  const hiddenWidgets = homeWidgetCatalog.filter((id) => {
    if (id === 'music' && !isPro) return false;
    if (id === 'loadouts' && !isPro) return false;
    if (id === 'tracker' && !hasIiTracker) return false;
    const row = homeWidgets.find((item) => item.id === id);
    return !(row?.visible ?? false);
  });

  const visibleWidgets = homeWidgets.filter(
    (widget) =>
      widget.visible &&
      !(widget.id === 'music' && !isPro) &&
      !(widget.id === 'tracker' && !hasIiTracker),
  );
  const mainWidgets = visibleWidgets.filter((widget) => widget.zone === 'main');
  const railWidgets = visibleWidgets.filter((widget) => widget.zone === 'rail');
  const belowWidgets = visibleWidgets.filter((widget) => widget.zone === 'below');

  function renderWidgetSlot(widget: HomeWidget) {
    const lifted = liftId === widget.id;
    const size = widget.size ?? 'regular';
    return (
      <div
        key={widget.id}
        data-home-widget={widget.id}
        data-home-size={size}
        className={`home-drag-slot size-${size} ${lifted ? 'lifted' : ''} ${editMode ? 'editing' : ''}`}
        style={lifted ? { minHeight: dragRef.current?.height } : undefined}
      >
        <div
          className={lifted ? 'home-drag-float' : 'home-drag-surface'}
          style={
            lifted
              ? {
                  position: 'fixed',
                  top: liftBox.top,
                  left: liftBox.left,
                  width: liftBox.width,
                  zIndex: 40,
                }
              : undefined
          }
        >
          {editMode && (
            <div className="home-widget-chrome" data-home-widget-ignore="1">
              <button
                type="button"
                className="home-widget-size"
                aria-label={
                  size === 'compact'
                    ? `Make ${homeWidgetLabels[widget.id]} full width`
                    : `Make ${homeWidgetLabels[widget.id]} half width`
                }
                title={size === 'compact' ? 'Expand to full width' : 'Shrink to half width'}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleWidgetSize(widget.id);
                }}
              >
                <EngineIcon name="layout" size={13} />
              </button>
              <button
                type="button"
                className="home-widget-remove"
                aria-label={`Remove ${homeWidgetLabels[widget.id]}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  removeHomeWidget(widget.id);
                }}
              >
                <EngineIcon name="close" size={13} />
              </button>
            </div>
          )}
          {widget.id === 'assistant' && (
            <section className="home-assistant dashboard-card" aria-label="ii menu assistant">
              <header>
                <strong>
                  <EngineIcon name="bot" size={16} /> Ask about the menu
                </strong>
                <span>
                  Gorilla Tag · ii Reborn Menu features · Engine tips
                  {assistRemaining != null ? ` · ${assistRemaining} left today` : ''}
                </span>
              </header>
              <form onSubmit={(event) => void askHomeAssistant(event)}>
                <input
                  value={assistQuestion}
                  maxLength={2000}
                  placeholder="e.g. How do I open Favorite Mods? What does Speed boost do?"
                  onChange={(event) => setAssistQuestion(event.target.value)}
                  disabled={assistBusy}
                />
                <button type="submit" disabled={assistBusy || !assistQuestion.trim()}>
                  {assistBusy ? 'Thinking…' : 'Ask'}
                </button>
              </form>
              {assistError && (
                <p className="home-assistant-error" role="alert">
                  {assistError}
                </p>
              )}
              {assistTurn && (
                <div className="home-assistant-thread" role="log" aria-live="polite">
                  <div className="home-assistant-turn">
                    <p className="home-assistant-question">
                      <strong>You</strong> {assistTurn.question}
                    </p>
                    <div className="home-assistant-answer" role="status">
                      {assistTurn.answer}
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}
          {widget.id === 'music' && <BackgroundMusic demo={data.demo} />}
          {widget.id === 'modChecker' && (
            <div className="dashboard-card home-mod-checker-slot">
              <AiModChecker demo={data.demo} />
            </div>
          )}
          {widget.id === 'health' && (
            <section className="dashboard-card home-health-card" aria-label="System health">
              <div className="card-heading">
                <span className="card-heading-glyph is-health">
                  <EngineIcon name="health" size={19} />
                </span>
                <div className="card-heading-text">
                  <h2>System Health</h2>
                  <p>{healthVerdict}</p>
                </div>
                <span className={`state-pill ${allHealthy ? '' : 'is-pending'}`}>
                  <span className="status-dot" />
                  {allHealthy ? 'Healthy' : 'Check needed'}
                </span>
              </div>
              <div className="home-inset-list">
                {healthRows.map((row) => (
                  <button
                    type="button"
                    key={row.label}
                    className="home-inset-row"
                    onClick={() => navigate('Health & Repair')}
                  >
                    <span className={`status-dot ${row.ok ? '' : 'amber'}`} />
                    <span className="home-inset-label">{row.label}</span>
                    <span className={`home-inset-value ${row.ok ? 'is-good' : 'is-pending'}`}>
                      {row.value}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {widget.id === 'community' && (
            <section className="dashboard-card home-community-card" aria-label="Community">
              <div className="card-heading">
                <span className="card-heading-glyph">
                  <EngineIcon name="users" size={19} />
                </span>
                <div className="card-heading-text">
                  <h2>Community</h2>
                  <p>Join the conversation and get help.</p>
                </div>
              </div>
              <a
                className="home-link-row is-discord"
                href={official}
                target="_blank"
                rel="noreferrer"
                onClick={externalClick(official)}
              >
                <span className="home-link-tile">
                  <EngineIcon name="discord" size={19} />
                </span>
                <span className="home-link-text">
                  Join our Discord<small>News, support, and releases</small>
                </span>
                <EngineIcon name="external" size={15} />
              </a>
              <button type="button" className="home-link-row" onClick={() => navigate('Community')}>
                <span className="home-link-tile">
                  <EngineIcon name="news" size={19} />
                </span>
                <span className="home-link-text">
                  View Announcements<small>Latest updates from the team</small>
                </span>
                <EngineIcon name="chevronRight" size={15} />
              </button>
              <footer className="home-community-foot">
                <span>Made for the ii community.</span>
                <span>Play better, together.</span>
              </footer>
            </section>
          )}
          {widget.id === 'studio' && (
            <button
              type="button"
              className="dashboard-card home-shortcut-pill"
              onClick={() => navigate('ii Studio')}
            >
              <EngineIcon name="studio" size={18} />
              <span>
                ii Studio<small>Build and play mods</small>
              </span>
              <EngineIcon name="chevronRight" size={16} />
            </button>
          )}
          {widget.id === 'weeklyPicks' && (
            <section
              className="dashboard-card home-weekly-picks"
              aria-label="Top 3 picks of the week"
            >
              <div className="card-heading">
                <div className="card-heading-text">
                  <h2>Top 3 picks of the week</h2>
                  <p>Highest-voted trusted and community mods right now.</p>
                </div>
              </div>
              <ol className="home-weekly-picks-list">
                {(weeklyPicks.data?.items ?? []).slice(0, 3).map((pick, index) => (
                  <li key={pick.id}>
                    <span className="home-weekly-rank">{index + 1}</span>
                    <div>
                      <strong>{pick.name}</strong>
                      <small>
                        {pick.target_type} · score {pick.score}
                      </small>
                      <p>{pick.description}</p>
                    </div>
                  </li>
                ))}
                {!weeklyPicks.data?.items?.length && (
                  <li className="empty-row">Picks show up once mods start getting votes.</li>
                )}
              </ol>
              <button type="button" className="text-button" onClick={() => navigate('Autoloader')}>
                Open Mod Library
              </button>
            </section>
          )}
          {widget.id === 'tracker' && hasIiTracker && (
            <HomeTrackerPills
              demo={data.demo}
              navigate={navigate}
              compact={(widget.size ?? 'regular') === 'compact'}
            />
          )}
          {widget.id === 'loadouts' && isPro && (
            <section className="dashboard-card home-loadouts-card" aria-label="Mod loadouts">
              <div className="card-heading">
                <div className="card-heading-text">
                  <h2>Loadouts</h2>
                  <p>Your named Pro mod sets.</p>
                </div>
              </div>
              <ul className="home-loadouts-list">
                {loadouts.slice(0, 4).map((loadout) => (
                  <li key={loadout.id}>
                    <strong>{loadout.name}</strong>
                    <small>{loadout.mods.length} mods</small>
                  </li>
                ))}
                {!loadouts.length && (
                  <li className="empty-row">No loadouts yet — create one in Mods.</li>
                )}
              </ul>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  try {
                    sessionStorage.setItem('ii-mod-library-tab', 'loadouts');
                  } catch {}
                  setLoadoutTick((value) => value + 1);
                  navigate('Autoloader');
                }}
              >
                Manage loadouts
              </button>
            </section>
          )}
          {widget.id === 'backups' && (
            <button
              type="button"
              className="dashboard-card home-shortcut-pill"
              onClick={() => navigate('Backups')}
            >
              <EngineIcon name="backup" size={18} />
              <span>
                Backups<small>Restore previous installs</small>
              </span>
              <EngineIcon name="chevronRight" size={16} />
            </button>
          )}
          {widget.id === 'account' && (
            <section className="dashboard-card account-card" aria-label="Account and status">
              <div className="card-heading">
                <div className="card-heading-text">
                  <h2>Account &amp; Status</h2>
                  <p>Manage your account and see system status.</p>
                </div>
              </div>
              <div className="account-overview">
                <div className="discord-avatar">
                  {data.member.avatar ? (
                    <img
                      src={data.member.avatar}
                      alt={`${data.member.display_name}'s Discord avatar`}
                    />
                  ) : (
                    <EngineIcon name="discord" size={26} />
                  )}
                  <span className={data.demo ? 'account-presence demo' : 'account-presence'} />
                </div>
                <div className="account-name">
                  <strong>
                    <span className="account-display-name">{data.member.display_name}</span>
                    <span className={`account-plan-badge badge-${memberBadge.replace(' ', '-')}`}>
                      {memberBadge}
                    </span>
                  </strong>
                  <span className="account-state">
                    <span className={`status-dot ${data.demo ? 'amber' : ''}`} />
                    Signed in
                  </span>
                </div>
                <button className="manage-account" onClick={() => navigate('Settings')}>
                  Manage Account
                </button>
              </div>
              <div className="account-status-list">
                {accountRows.map((row) => (
                  <button
                    type="button"
                    key={row.label}
                    onClick={() => navigate('Health & Repair')}
                    aria-label={`${row.label}: ${row.value}`}
                  >
                    <EngineIcon name={row.icon} size={17} />
                    <span className="account-status-label">{row.label}</span>
                    <strong className={row.ok ? 'is-good' : 'is-pending'}>{row.value}</strong>
                    <EngineIcon name="chevronRight" size={15} />
                  </button>
                ))}
              </div>
            </section>
          )}
          {widget.id === 'managed' && <ManagedContent />}
          {widget.id === 'announcements' && (
            <section className="dashboard-card dashboard-announcements">
              <div className="card-heading">
                <span className="card-heading-glyph is-tile">
                  <EngineIcon name="document" size={16} />
                </span>
                <div className="card-heading-text">
                  <h2>Latest Announcements</h2>
                  <p>News and updates from the ii community.</p>
                </div>
                <button className="card-link" onClick={() => navigate('Community')}>
                  View All <EngineIcon name="arrowRight" size={14} />
                </button>
              </div>
              <div className="announcement-list">
                {data.announcements.slice(0, 3).map((item) => (
                  <button
                    className="announcement-row"
                    key={item.id}
                    onClick={() => navigate('Community')}
                  >
                    <span className="announcement-avatar">
                      {item.avatar ? (
                        <img src={item.avatar} alt="" />
                      ) : (
                        <EngineIcon name="user" size={16} />
                      )}
                    </span>
                    <strong
                      className="announcement-author"
                      style={item.author_color ? { color: item.author_color } : undefined}
                    >
                      {item.author_emoji && <span aria-hidden="true">{item.author_emoji} </span>}
                      {item.author}
                    </strong>
                    <span className="announcement-text">{item.text}</span>
                    <time>
                      {new Date(item.timestamp).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </time>
                    <EngineIcon name="chevronRight" size={15} />
                  </button>
                ))}
                {!data.announcements.length && (
                  <p className="dashboard-empty">No announcements right now.</p>
                )}
              </div>
            </section>
          )}
          {widget.id === 'quickActions' && (
            <section className="dashboard-card quick-actions">
              <div className="card-heading">
                <span className="card-heading-glyph">
                  <EngineIcon name="zap" size={18} />
                </span>
                <div className="card-heading-text">
                  <h2>Quick Actions</h2>
                  <p>Common tasks to keep your game running smoothly.</p>
                </div>
                <button className="card-link" onClick={() => navigate('Health & Repair')}>
                  View All <EngineIcon name="arrowRight" size={14} />
                </button>
              </div>
              <div className="action-grid">
                <button
                  className="action-tile primary"
                  disabled={launching || updatingMenu || !canLaunch}
                  onClick={() => void runLauncher(true)}
                >
                  <EngineIcon name="play" size={20} />
                  <span>
                    Launch with ii Menu<small>Start Gorilla Tag</small>
                  </span>
                </button>
                {menuUpdate?.updateAvailable && (
                  <button
                    className="action-tile"
                    disabled={launching || updatingMenu}
                    onClick={() => void runMenuUpdate()}
                  >
                    <EngineIcon name="download" size={20} />
                    <span>
                      {menuUpdate.missing ? 'Install ii Menu' : 'Update ii Menu'}
                      <small>
                        {menuUpdate.release?.version
                          ? `Version ${menuUpdate.release.version} · Launch never auto-updates`
                          : 'Confirmed install · Launch never auto-updates'}
                      </small>
                    </span>
                  </button>
                )}
                <button className="action-tile" onClick={() => navigate('Health & Repair')}>
                  <EngineIcon name="wrench" size={20} />
                  <span>
                    Scan Files<small>Check for issues</small>
                  </span>
                </button>
                <button className="action-tile" onClick={() => navigate('Autoloader')}>
                  <EngineIcon name="mods" size={20} />
                  <span>
                    Manage Mods<small>Open Mod Library</small>
                  </span>
                </button>
                <button className="action-tile" onClick={() => navigate('Backups')}>
                  <EngineIcon name="backup" size={20} />
                  <span>
                    Backups<small>View saves</small>
                  </span>
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`dashboard home-dashboard ${homeBackgroundSrc ? 'has-home-bg' : ''}`}>
      {homeBackgroundSrc && (
        <div className="home-bg-layer" aria-hidden="true">
          <div
            className="home-bg-image"
            style={{
              backgroundImage: `url(${homeBackgroundSrc})`,
              filter: homeBackgroundBlur ? `blur(${homeBackgroundBlurIntensity}px)` : undefined,
              transform: homeBackgroundBlur ? 'scale(1.12)' : undefined,
            }}
          />
          <div className="home-bg-scrim" />
        </div>
      )}
      <div
        className={`home-arrange ${editMode ? 'is-editing' : ''} ${liftId ? 'is-dragging' : ''}`}
        ref={stackRef}
        onPointerDown={onArrangeDown}
        onPointerMove={onArrangeMove}
        onPointerUp={onArrangeUp}
        onPointerCancel={onArrangeUp}
      >
        {isPro && !editMode && (
          <div className="home-arrange-hint-row" data-home-widget-ignore="1">
            <button
              type="button"
              className="home-edit-start"
              onClick={() => {
                editModeRef.current = true;
                setEditMode(true);
              }}
            >
              Edit layout
            </button>
          </div>
        )}
        {isPro && editMode && (
          <div className="home-edit-toolbar" data-home-widget-ignore="1">
            <p>
              Drag to <strong>Under launch</strong>, <strong>Right side</strong>, or{' '}
              <strong>Bottom row</strong> · resize Launch or cards · × to remove
            </p>
            <button type="button" className="home-edit-done" onClick={exitEditMode}>
              <EngineIcon name="check" size={15} />
              Done
            </button>
          </div>
        )}
        {isPro && editMode && (
          <div
            className="home-widget-dock"
            data-home-widget-ignore="1"
            role="toolbar"
            aria-label="Add widgets"
          >
            <div className="home-widget-dock-label">
              <EngineIcon name="plus" size={15} />
              Add widgets
            </div>
            <div className="home-widget-dock-scroll">
              {hiddenWidgets.length === 0 ? (
                <span className="home-widget-dock-empty">All widgets are on Home</span>
              ) : (
                hiddenWidgets.map((id) => (
                  <button
                    key={id}
                    type="button"
                    title={homeWidgetBlurbs[id]}
                    onClick={() => addHomeWidget(id)}
                  >
                    <EngineIcon name="plus" size={14} />
                    {homeWidgetLabels[id]}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
        <div
          className={`home-columns launch-hero-${launchHeroSize}${editMode ? ' is-editing-launch' : ''}`}
        >
          <div className="home-col-main">
            <div className="dashboard-top launch-only">
              <section
                className={`launch-banner launch-banner-clean launch-hero size-${launchHeroSize}`}
                aria-label="Launch Gorilla Tag"
                data-tour="home-launch"
              >
                {isPro && editMode && (
                  <div
                    className="home-widget-chrome launch-hero-chrome"
                    data-home-widget-ignore="1"
                  >
                    <button
                      type="button"
                      className="home-widget-size"
                      aria-label={
                        launchHeroSize === 'compact'
                          ? 'Make Launch card full width'
                          : 'Make Launch card half width'
                      }
                      title={
                        launchHeroSize === 'compact'
                          ? 'Expand Launch to full width'
                          : 'Shrink Launch to half width'
                      }
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleLaunchHeroSize();
                      }}
                    >
                      <EngineIcon name="layout" size={13} />
                    </button>
                  </div>
                )}
                <div className="launch-hero-glow" aria-hidden="true" />
                <div className="launch-hero-streak" aria-hidden="true" />
                <div className="launch-hero-shards" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="launch-hero-words" aria-hidden="true">
                  <span>PLAY</span>
                  <span>MOD</span>
                  <span>EXPLORE</span>
                  <i className="launch-hero-rule" />
                </div>
                <div className="banner-content launch-hero-main">
                  <span className="eyebrow muted-eyebrow launch-hero-kicker">II ENGINE</span>
                  <h1 className="launch-hero-title">
                    <span>Launch Gorilla Tag</span> <span>with ii</span>
                  </h1>
                  <p className="launch-hero-sub">
                    A safer, simpler way to mod and launch Gorilla Tag.
                  </p>
                  <div className="launch-buttons launch-hero-cta" ref={launchMenuRef}>
                    <button
                      className="primary play-primary"
                      aria-label="Launch with ii Reborn"
                      disabled={launching || updatingMenu || !canLaunch}
                      onClick={() => void runLauncher(true)}
                    >
                      <EngineIcon name="play" size={18} />
                      {launching
                        ? 'Checking installation…'
                        : canLaunch
                          ? 'Launch with ii Menu'
                          : 'Launch access required'}
                    </button>
                    {menuUpdate?.updateAvailable && (
                      <button
                        type="button"
                        className="secondary menu-update-cta"
                        aria-label={
                          menuUpdate.missing
                            ? `Install ii Menu ${menuUpdate.release?.version ?? ''}`.trim()
                            : `Update ii Menu ${menuUpdate.release?.version ?? ''}`.trim()
                        }
                        disabled={launching || updatingMenu}
                        onClick={() => void runMenuUpdate()}
                      >
                        <EngineIcon name="download" size={18} />
                        {updatingMenu
                          ? 'Updating…'
                          : menuUpdate.missing
                            ? `Install ii Menu${menuUpdate.release?.version ? ` ${menuUpdate.release.version}` : ''}`
                            : `Update ii Menu${menuUpdate.release?.version ? ` ${menuUpdate.release.version}` : ''}`}
                      </button>
                    )}
                    <button
                      ref={launchOptionsBtnRef}
                      className="launch-options"
                      aria-label="Open launch options"
                      aria-expanded={options}
                      disabled={launching || updatingMenu}
                      onClick={() => setOptions(!options)}
                    >
                      <EngineIcon name="chevronDown" size={16} />
                    </button>
                    {options &&
                      launchMenuBox &&
                      createPortal(
                        <div
                          ref={launchMenuPanelRef}
                          className="launch-menu launch-menu-portal"
                          style={{
                            position: 'fixed',
                            top: launchMenuBox.top,
                            left: launchMenuBox.left,
                            width: launchMenuBox.width,
                            zIndex: 100000,
                          }}
                        >
                          <button
                            disabled={launching || !canLaunch}
                            onClick={() => void playWithoutIi()}
                          >
                            <EngineIcon name="play" size={16} /> Play without ii
                          </button>
                          <button
                            disabled={launching || !canLaunch}
                            onClick={() => void playWithCurrentSetup()}
                            title="Does not update or disable the menu. Uses whatever is already installed"
                          >
                            <EngineIcon name="play" size={16} /> Play with current setup
                          </button>
                          <button
                            className="launch-kraken-option"
                            disabled={
                              launching ||
                              updatingMenu ||
                              !canLaunch ||
                              !!preferences.krakenSession?.active
                            }
                            onClick={() => {
                              setOptions(false);
                              setKrakenConfirmOpen(true);
                            }}
                          >
                            <EngineIcon name="warning" size={16} /> The Kraken
                          </button>
                          <button disabled={launching} onClick={() => void runLauncher(false)}>
                            Verify File Integrity
                          </button>
                          <label>
                            Choose Menu Release
                            <CustomSelect
                              label="Choose menu release"
                              value={preferences.selectedReleaseId ?? 'latest'}
                              onChange={(value) =>
                                preferences.setSelectedRelease(value === 'latest' ? null : value)
                              }
                              options={[
                                { value: 'latest', label: 'Latest Release' },
                                ...(releases.data?.items.slice(1).map((release) => ({
                                  value: release.id,
                                  label: `${release.name} · ${release.version}`,
                                })) ?? []),
                              ]}
                            />
                          </label>
                          {chosen && (
                            <div className="release-choice-summary">
                              <strong>
                                {chosen.name} · {chosen.version}
                              </strong>
                              <small>
                                {chosen.id === releases.data?.latest_id ? 'Latest release · ' : ''}
                                {new Date(chosen.published_at).toLocaleDateString()}
                              </small>
                              <p>
                                {[
                                  ...chosen.changelog.added,
                                  ...chosen.changelog.changed,
                                  ...chosen.changelog.fixes,
                                ][0] ||
                                  chosen.release_notes ||
                                  'No changelog was supplied.'}
                              </p>
                            </div>
                          )}
                          <button onClick={() => navigate('Health & Repair')}>
                            Advanced Health &amp; Repair
                          </button>
                          {(scanStage || launchStatus || launchError) && (
                            <div
                              className={`launch-menu-status ${launchError ? 'error' : ''}`}
                              role={launchError ? 'alert' : 'status'}
                            >
                              {scanStage ||
                                (launchError && isAntivirusLockError(launchError)
                                  ? 'Antivirus is locking the menu file — use the help below.'
                                  : launchError) ||
                                launchStatus}
                            </div>
                          )}
                        </div>,
                        document.body,
                      )}
                  </div>
                  <div className="banner-status-row launch-hero-meta">
                    <small>Version {engineVersion}</small>
                    <i aria-hidden="true">•</i>
                    <span className={installReady || data.demo ? '' : 'is-pending'}>
                      {installReady || data.demo
                        ? 'Up to date'
                        : healthStatus !== 'Not checked'
                          ? healthStatus
                          : 'Run Health & Repair'}
                    </span>
                  </div>
                  {launchStatus && !options && (
                    <div className="launch-feedback" role="status">
                      {launchStatus}
                    </div>
                  )}
                  {launchError && !options && (
                    <div className="launch-feedback error" role="alert">
                      {isAntivirusLockError(launchError) ? (
                        <AntivirusLockHelp
                          message={launchError}
                          onRetry={() => void runMenuUpdate()}
                        />
                      ) : (
                        launchError
                      )}
                    </div>
                  )}
                  {(consoleOpen || logEnabled) && (
                    <div className="home-launch-console" aria-label="In-engine game console">
                      <header>
                        <strong>
                          <EngineIcon name="terminal" size={14} /> Runtime console
                        </strong>
                        <div>
                          <button type="button" onClick={() => setConsoleOpen((value) => !value)}>
                            {consoleOpen ? 'Collapse' : 'Expand'}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              logOffset.current = 0;
                              setLogText('');
                            }}
                          >
                            Clear
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (logText.trim().length >= 40) {
                                appendSessionBepInEx(logText, gamePath);
                              }
                              setLogEnabled(false);
                              setConsoleOpen(false);
                            }}
                          >
                            Close
                          </button>
                        </div>
                      </header>
                      {consoleOpen && (
                        <pre className="home-launch-console-body">
                          {logText ||
                            (data.demo
                              ? 'Launch with ii Menu on the desktop app to stream BepInEx logs here.'
                              : 'Waiting for BepInEx LogOutput.log…')}
                          <span ref={logEnd} />
                        </pre>
                      )}
                    </div>
                  )}
                  {operations.data?.countdown?.enabled && target > now && (
                    <div className="release-countdown" role="timer">
                      <span>{operations.data.countdown.title}</span>
                      <strong>{countdown}</strong>
                    </div>
                  )}
                </div>
              </section>
            </div>
            <div className="home-zone-stack" data-home-zone="main">
              {editMode && (
                <p className="home-zone-label" data-home-widget-ignore="1">
                  {homeWidgetZoneLabels.main}
                </p>
              )}
              {mainWidgets.map((widget) => renderWidgetSlot(widget))}
              {editMode && mainWidgets.length === 0 && (
                <div className="home-zone-empty" data-home-widget-ignore="1">
                  Drop cards here
                </div>
              )}
            </div>
          </div>
          <aside className="home-col-rail" aria-label="Account and system status">
            <div className="home-zone-stack" data-home-zone="rail">
              {editMode && (
                <p className="home-zone-label" data-home-widget-ignore="1">
                  {homeWidgetZoneLabels.rail}
                </p>
              )}
              {railWidgets.map((widget) => renderWidgetSlot(widget))}
              {editMode && railWidgets.length === 0 && (
                <div className="home-zone-empty" data-home-widget-ignore="1">
                  Drop cards here
                </div>
              )}
            </div>
          </aside>
        </div>
        <section className="home-zone-below" aria-label="Home footer cards">
          <div className="home-zone-stack" data-home-zone="below">
            {editMode && (
              <p className="home-zone-label" data-home-widget-ignore="1">
                {homeWidgetZoneLabels.below}
              </p>
            )}
            {belowWidgets.map((widget) => renderWidgetSlot(widget))}
            {editMode && belowWidgets.length === 0 && (
              <div className="home-zone-empty" data-home-widget-ignore="1">
                Drop cards here for a full-width footer row
              </div>
            )}
          </div>
        </section>
      </div>

      {krakenConfirmOpen &&
        createPortal(
          <div className="tutorial-backdrop kraken-backdrop">
            <section
              className="tutorial-card kraken-confirm-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="kraken-title"
            >
              <span className="eyebrow kraken-eyebrow">
                <EngineIcon name="warning" size={14} /> EXTREMELY DANGEROUS
              </span>
              <h2 id="kraken-title">Release The Kraken?</h2>
              <p>
                The Kraken creates a safety backup of your plugins folder, installs{' '}
                <strong>every available trusted mod and every community mod</strong>, then launches
                Gorilla Tag with all of them loaded.
              </p>
              <ul className="kraken-warn-list">
                <li>
                  Community mods are not verified like trusted mods. There is a real chance a
                  community mod could be malicious.
                </li>
                <li>
                  Loading this many plugins can lag, crash, soft-lock, or make the game unplayable.
                </li>
                <li>
                  When Gorilla Tag closes, ii Engine removes every mod The Kraken added and restores
                  your previous plugins. Your safety backup stays in Engine local data.
                </li>
              </ul>
              <label className="kraken-check">
                <input
                  type="checkbox"
                  checked={krakenAckMalice}
                  onChange={(event) => setKrakenAckMalice(event.target.checked)}
                />
                I understand community mods may be malicious.
              </label>
              <label className="kraken-check">
                <input
                  type="checkbox"
                  checked={krakenAckStability}
                  onChange={(event) => setKrakenAckStability(event.target.checked)}
                />
                I understand the game may lag, crash, or become unplayable.
              </label>
              <label className="kraken-phrase">
                Type <code>{KRAKEN_CONFIRM_PHRASE}</code> to continue
                <input
                  value={krakenPhrase}
                  onChange={(event) => setKrakenPhrase(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={KRAKEN_CONFIRM_PHRASE}
                />
              </label>
              <div className="tutorial-actions">
                <button className="text-button" onClick={resetKrakenConfirm}>
                  Cancel
                </button>
                <button
                  className="primary kraken-confirm-button"
                  disabled={!krakenReady || launching}
                  onClick={() => void runTheKraken()}
                >
                  Release The Kraken
                </button>
              </div>
            </section>
          </div>,
          document.body,
        )}
    </div>
  );
}
