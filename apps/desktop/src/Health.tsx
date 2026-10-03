import { useEffect, useMemo, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useQuery } from '@tanstack/react-query';
import { EngineIcon } from './EngineIcon';
import PageHero from './PageHero';
import {
  detectGame,
  downloadMenuRelease,
  getMenuReleases,
  matchesRelease,
  repairInstallation,
  scanInstallation,
  selectedRelease,
  type HealthReport,
} from './launcher';
import { readMenuCatalogCache } from './menuCatalogCache';
import { usePreferences, type Page } from './store';
import { CustomSelect } from './CustomSelect';
import { externalClick, openExternal } from './external';
import { trackFeature } from './telemetry';
import AiModChecker from './AiModChecker';
import AntivirusLockHelp from './AntivirusLockHelp';
import { isAntivirusLockError } from './antivirusHelp';
import GameFilesBrowser from './GameFilesBrowser';

type RepairMode = 'targeted' | 'menu' | 'bepinex';
type RepairPreview = {
  token: string;
  menu_version: string;
  backup_bytes: number;
  scopes: string[];
  changes: number;
};
type EngineUpdateStatus = {
  current_version: string;
  latest_version: string | null;
  outdated: boolean;
  download_url: string | null;
  release_url: string | null;
  can_install: boolean;
  detail: string;
};

const official = 'https://discord.gg/iidk';
const engineReleasesUrl = 'https://github.com/iireborn/iiEngine/releases';

const demoReport: HealthReport = {
  status: 'Needs attention',
  files: [],
  checks: [
    {
      name: 'Desktop access',
      status: 'Unavailable',
      detail: 'Open the Windows desktop app to inspect and repair local game files.',
    },
  ],
};

export default function Health({
  demo,
  isPro = false,
  onStatus,
  navigate,
}: {
  demo: boolean;
  isPro?: boolean;
  onStatus?: (status: string) => void;
  navigate?: (page: Page) => void;
}) {
  const { selectedReleaseId, setSelectedRelease } = usePreferences();
  const releases = useQuery({
    queryKey: ['menu-releases'],
    queryFn: getMenuReleases,
    enabled: !demo,
    staleTime: 30_000,
    placeholderData: () => readMenuCatalogCache() ?? undefined,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
  const release = useMemo(
    () => selectedRelease(releases.data, selectedReleaseId),
    [releases.data, selectedReleaseId],
  );
  const [gamePath, setGamePath] = useState<string | null>(null);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [resetPreview, setResetPreview] = useState<RepairPreview | null>(null);
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [cleanResetOpen, setCleanResetOpen] = useState(false);
  const [cleanResetConfirmation, setCleanResetConfirmation] = useState('');
  const [cleanResetBackup, setCleanResetBackup] = useState('');
  const [toolsOpen, setToolsOpen] = useState(false);
  const [scannedAt, setScannedAt] = useState<Date | null>(null);
  const [scanNotice, setScanNotice] = useState('');
  const [expandedCheck, setExpandedCheck] = useState<string | null>(null);
  const [engineUpdate, setEngineUpdate] = useState<EngineUpdateStatus | null>(null);
  const [engineUpdateBusy, setEngineUpdateBusy] = useState(false);

  const releaseMatches = report && release ? matchesRelease(report, release) : false;
  const healthy = Boolean(report && report.status === 'Healthy' && (!release || releaseMatches));
  const sortedChecks = useMemo(
    () =>
      [...(report?.checks ?? [])].sort((left, right) => {
        const rank = (status: string) =>
          status.toLowerCase().includes('error') || status.toLowerCase().includes('missing')
            ? 0
            : status.toLowerCase().includes('warn') || status.toLowerCase().includes('old')
              ? 1
              : 2;
        return rank(left.status) - rank(right.status);
      }),
    [report],
  );
  const isDllPathCheck = (name: string) =>
    name.startsWith('BepInEx/plugins/') && name.toLowerCase().endsWith('.dll');
  const coreChecks = sortedChecks.filter((check) => !isDllPathCheck(check.name));
  const issueChecks = coreChecks.filter(
    (check) =>
      check.status !== 'Healthy' &&
      check.name !== 'Release integrity' &&
      check.name !== 'Extra plugins',
  );
  const healthyChecks = coreChecks.filter((check) => check.status === 'Healthy').length;
  const findCheck = (name: string) =>
    report?.checks.find((check) => check.name.toLowerCase() === name.toLowerCase()) ?? null;
  const gameCheck = findCheck('Game installation');
  const loaderCheck = findCheck('Loader version');
  const menuCheck = findCheck('Menu copies');
  const loaderVersion =
    loaderCheck?.detail.match(/^BepInEx\s+([^\s(;]+)/)?.[1]?.trim() ??
    loaderCheck?.detail.match(/found ([^;]+)$/)?.[1]?.trim() ??
    null;
  const installedMenuVersion =
    report?.files.find((file) => file.menu)?.plugins.find((plugin) => plugin.version)?.version ??
    null;
  const menuDlls = report?.files.filter((file) => file.menu) ?? [];
  const extraDlls = report?.files.filter((file) => !file.menu) ?? [];
  const scanSummary = !report
    ? 'Checking installation'
    : issueChecks.length
      ? `${issueChecks.length} ${issueChecks.length === 1 ? 'item needs' : 'items need'} attention`
      : release && !releaseMatches
        ? 'Menu update available'
        : 'All checks passed';

  async function scan(path = gamePath, opts: { paced?: boolean } = {}) {
    const paced = opts.paced ?? false;
    setBusy(true);
    setError('');
    setScanNotice('');
    setProgress(demo ? 'Loading the demo health report…' : 'Scanning Gorilla Tag and BepInEx…');
    const started = Date.now();
    try {
      let notice = '';
      if (demo) {
        setReport(demoReport);
        onStatus?.('Needs attention');
        setScannedAt(new Date());
        notice = 'Scan complete · 1 item needs attention (demo report).';
      } else {
        if (!isTauri()) throw new Error('Health checks require the Windows desktop app.');
        const detected = path ?? (await detectGame());
        setGamePath(detected);
        const result = await scanInstallation(detected);
        setReport(result);
        onStatus?.(result.status);
        setScannedAt(new Date());
        const issues = result.checks.filter(
          (check) =>
            check.status !== 'Healthy' &&
            !check.name.startsWith('BepInEx/plugins/') &&
            check.name !== 'Release integrity' &&
            check.name !== 'Extra plugins',
        ).length;
        notice = issues
          ? `Scan complete · ${issues} ${issues === 1 ? 'item needs' : 'items need'} attention. See System Check below.`
          : 'Scan complete · all checks passed. Results are listed under System Check.';
      }
      if (paced) {
        const wait = Math.max(0, 1200 - (Date.now() - started));
        if (wait) await new Promise((resolve) => window.setTimeout(resolve, wait));
      }
      setProgress('');
      setScanNotice(notice);
    } catch (reason) {
      setProgress('');
      setScanNotice('');
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function refreshEngineUpdate() {
    if (demo || !isTauri()) {
      setEngineUpdate({
        current_version: '0.2.2',
        latest_version: null,
        outdated: false,
        download_url: null,
        release_url: engineReleasesUrl,
        can_install: false,
        detail: 'Open the Windows desktop app to check for ii Engine updates.',
      });
      return;
    }
    try {
      const status = await invoke<EngineUpdateStatus>('check_engine_update');
      setEngineUpdate(status);
    } catch (reason) {
      setEngineUpdate({
        current_version: '0.2.2',
        latest_version: null,
        outdated: false,
        download_url: null,
        release_url: engineReleasesUrl,
        can_install: false,
        detail: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }

  async function installEngineUpdate() {
    if (!engineUpdate?.download_url) return;
    setEngineUpdateBusy(true);
    setError('');
    setProgress('Downloading the latest ii Engine installer…');
    try {
      const destination = await invoke<string>('download_engine_installer', {
        downloadUrl: engineUpdate.download_url,
      });
      setProgress(`Saved installer to ${destination}. Opening it now…`);
      await invoke('open_local_path', { path: destination });
      trackFeature('engine_update_install', engineUpdate.latest_version || 'unknown');
      setProgress('Installer opened. Finish the update, then relaunch ii Engine.');
    } catch (reason) {
      setProgress('');
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setEngineUpdateBusy(false);
    }
  }

  useEffect(() => {
    void scan(undefined, { paced: false });
    void refreshEngineUpdate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);

  async function repair(mode: RepairMode) {
    if (!release) {
      setError('No published menu release is available. Ask a developer to publish one first.');
      return;
    }
    setBusy(true);
    setError('');
    setToolsOpen(false);
    setProgress(
      mode === 'menu'
        ? 'Reinstalling the selected ii menu release…'
        : mode === 'bepinex'
          ? 'Installing BepInEx from GitHub Releases (pinned backup if needed)…'
          : 'Repairing the selected release and required loader files…',
    );
    try {
      const detected = gamePath ?? (await detectGame());
      setGamePath(detected);
      await repairInstallation(detected, release, mode, setProgress);
      trackFeature('health_repair', mode);
      const result = await scanInstallation(detected);
      setReport(result);
      onStatus?.(result.status);
      setScannedAt(new Date());
      setProgress(`${mode === 'targeted' ? 'Automatic repair' : 'Repair'} completed successfully.`);
    } catch (reason) {
      setProgress('');
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function prepareReset() {
    if (!gamePath) return;
    setBusy(true);
    setError('');
    setProgress('Preparing a settings backup and exact reset preview…');
    setToolsOpen(false);
    try {
      const preview = await invoke<RepairPreview>('prepare_reset_settings', {
        gamePath,
      });
      setResetPreview(preview);
      setResetConfirmed(false);
      setProgress('');
    } catch (reason) {
      setProgress('');
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function executeReset() {
    if (!resetPreview || !resetConfirmed) return;
    setBusy(true);
    setError('');
    setProgress('Backing up and resetting ii menu settings…');
    try {
      await invoke('execute_install', { token: resetPreview.token });
      setResetPreview(null);
      setResetConfirmed(false);
      setProgress('ii menu settings were backed up and reset.');
      await scan(gamePath);
    } catch (reason) {
      setProgress('');
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function openFolder(command: 'open_game_folder' | 'open_ii_folder') {
    if (!gamePath) return;
    setError('');
    try {
      await invoke(command, { gamePath });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function downloadDll() {
    if (!release) return;
    setBusy(true);
    setError('');
    setProgress(`Downloading ii ${release.version}…`);
    setToolsOpen(false);
    try {
      const destination = await downloadMenuRelease(release);
      setProgress(`Saved the verified DLL to ${destination}`);
    } catch (reason) {
      setProgress('');
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function beginCleanReinstall() {
    if (!gamePath || !release || cleanResetConfirmation !== 'RESET GORILLA TAG') return;
    setBusy(true);
    setError('');
    setProgress('Backing up plugins, removing Gorilla Tag files, and opening Steam uninstall…');
    try {
      const backup = await invoke<string>('start_clean_game_reinstall', {
        gamePath,
        confirmation: cleanResetConfirmation,
      });
      setCleanResetOpen(false);
      setCleanResetConfirmation('');
      setCleanResetBackup(backup);
      setGamePath(null);
      setReport(null);
      setProgress('Confirm Gorilla Tag removal in Steam, then continue here to reinstall it.');
    } catch (reason) {
      setProgress('');
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function continueCleanReinstall() {
    if (!release || !cleanResetBackup) return;
    setBusy(true);
    setError('');
    setProgress('Opening Steam to reinstall Gorilla Tag…');
    try {
      await invoke('continue_clean_game_reinstall');
      setProgress('Steam is reinstalling Gorilla Tag. Waiting for the clean game files…');
      let detected: string | null = null;
      for (let attempt = 0; attempt < 360 && !detected; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 5000));
        try {
          detected = await detectGame();
        } catch {}
      }
      if (!detected) {
        throw new Error(
          'Steam did not finish within 30 minutes. When it finishes, use Repair automatically to install BepInEx and ii.',
        );
      }
      setGamePath(detected);
      await repairInstallation(detected, release, 'targeted', setProgress);
      const result = await scanInstallation(detected);
      setReport(result);
      onStatus?.(result.status);
      if (!matchesRelease(result, release)) {
        throw new Error('The clean reinstall finished, but the selected ii DLL did not verify.');
      }
      setCleanResetBackup('');
      setProgress('Clean reinstall complete. Gorilla Tag, BepInEx, and ii are ready.');
    } catch (reason) {
      setProgress('');
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const lastScanLabel = scannedAt
    ? scannedAt.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'Not scanned yet';

  const scanRepairPromises = [
    { icon: 'checkCircle' as const, text: 'Checks the game files and BepInEx 5.x loader' },
    { icon: 'wrench' as const, text: 'Repairs from live GitHub, with a pinned BepInEx backup' },
    { icon: 'shield' as const, text: 'Safe and non-destructive. Nothing else is touched' },
    { icon: 'backup' as const, text: 'Backs up local settings before it writes' },
  ];

  return (
    <section className="health-repair-page">
      <PageHero
        label="Health and Repair"
        title="Health & Repair"
        subtitle="Scan and repair your Gorilla Tag install."
        words={['SCAN', 'REPAIR', 'PLAY']}
      />

      {(error || progress || scanNotice) && (
        <div
          className={`operation-banner ${error ? 'error' : progress ? 'progress' : 'success'}`}
          role={error ? 'alert' : 'status'}
          aria-live="polite"
        >
          {error ? (
            <strong>Action failed</strong>
          ) : progress ? (
            <strong>Working</strong>
          ) : (
            <strong>Scan complete</strong>
          )}
          {error && isAntivirusLockError(error) ? (
            <AntivirusLockHelp message={error} onRetry={() => void repair('menu')} />
          ) : (
            <span>{error || progress || scanNotice}</span>
          )}
          {scanNotice && !error && !progress && (
            <button type="button" className="text-button" onClick={() => setScanNotice('')}>
              Dismiss
            </button>
          )}
        </div>
      )}

      <div className="health-layout">
        <div className="health-main">
          <section className="engine-card scan-repair-card" aria-label="Scan and repair">
            <header className="engine-card-head">
              <EngineIcon name="zap" size={17} className="head-glyph" />
              <div>
                <h2>Scan &amp; Repair</h2>
                <p>Find problems and restore verified files safely.</p>
              </div>
            </header>
            <div className="scan-repair-body">
              <div className="scan-repair-actions">
                <div className="scan-primary-row">
                  <button
                    className="primary scan-primary"
                    disabled={busy}
                    onClick={() => void scan(undefined, { paced: true })}
                  >
                    <EngineIcon name="play" size={17} />
                    Scan for Issues
                  </button>
                  <button
                    className="primary scan-menu-toggle"
                    aria-expanded={toolsOpen}
                    aria-label="More repair tools"
                    disabled={busy}
                    onClick={() => setToolsOpen((value) => !value)}
                  >
                    <EngineIcon name="chevronDown" size={17} />
                  </button>
                </div>
                {toolsOpen && (
                  <div className="health-tools-menu">
                    {!demo && (
                      <label className="release-inline">
                        Menu release
                        <CustomSelect
                          label="Menu release used for repair"
                          value={release?.id ?? ''}
                          disabled={busy || !releases.data?.items.length}
                          onChange={setSelectedRelease}
                          options={
                            releases.data?.items.map((item) => ({
                              value: item.id,
                              label: `${item.version} · ${item.name}${item.id === releases.data?.latest_id ? ' (latest)' : ''}`,
                            })) ?? []
                          }
                        />
                      </label>
                    )}
                    <button disabled={busy || demo || !release} onClick={() => void repair('menu')}>
                      Reinstall ii menu
                    </button>
                    <button disabled={busy || demo || !release} onClick={() => void downloadDll()}>
                      Download selected DLL
                    </button>
                    <button
                      disabled={busy || demo || !release}
                      onClick={() => void repair('bepinex')}
                    >
                      Repair BepInEx (GitHub)
                    </button>
                    <button
                      disabled={busy || demo || !gamePath}
                      onClick={() => void prepareReset()}
                    >
                      Reset ii settings
                    </button>
                    <button
                      className="danger"
                      disabled={busy || demo || !gamePath || !release}
                      onClick={() => {
                        setCleanResetOpen(true);
                        setToolsOpen(false);
                      }}
                    >
                      Clean reinstall Gorilla Tag
                    </button>
                    <button
                      disabled={busy || demo || !gamePath}
                      onClick={() => void openFolder('open_game_folder')}
                    >
                      <EngineIcon name="folder" size={15} /> Open game folder
                    </button>
                    <button
                      disabled={busy || demo || !gamePath}
                      onClick={() => void openFolder('open_ii_folder')}
                    >
                      <EngineIcon name="external" size={15} /> Open ii folder
                    </button>
                  </div>
                )}
                <button
                  className="repair-auto"
                  disabled={busy || demo || !release}
                  onClick={() => void repair('targeted')}
                >
                  <EngineIcon name="wrench" size={16} />
                  <span>
                    Repair Automatically
                    <small>Restore the selected menu and required BepInEx files.</small>
                  </span>
                </button>
              </div>
              <ul className="scan-feature-list">
                {scanRepairPromises.map((promise) => (
                  <li key={promise.text}>
                    <EngineIcon name={promise.icon} size={16} />
                    {promise.text}
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="engine-card engine-update-card" aria-label="ii Engine version">
            <header className="engine-card-head">
              <EngineIcon name="zap" size={17} className="head-glyph" />
              <div>
                <h2>ii Engine</h2>
                <p>
                  {engineUpdate
                    ? engineUpdate.detail
                    : 'Checking GitHub Releases for a newer ii Engine build…'}
                </p>
              </div>
              <div className="engine-card-head-actions">
                <span
                  className={`engine-pill ${
                    engineUpdate?.outdated ? 'warn' : engineUpdate ? 'ok' : 'neutral'
                  }`}
                >
                  <i className="pill-dot" />
                  {engineUpdate?.outdated
                    ? 'Update available'
                    : engineUpdate
                      ? `v${engineUpdate.current_version}`
                      : 'Checking'}
                </span>
                <button
                  disabled={busy || engineUpdateBusy}
                  onClick={() => void refreshEngineUpdate()}
                >
                  <EngineIcon name="refresh" size={15} /> Check again
                </button>
              </div>
            </header>
            <div className="engine-update-actions">
              {engineUpdate?.outdated && engineUpdate.can_install ? (
                <button
                  className="primary"
                  disabled={busy || engineUpdateBusy || demo}
                  onClick={() => void installEngineUpdate()}
                >
                  <EngineIcon name="download" size={16} />
                  {engineUpdateBusy
                    ? 'Downloading…'
                    : `Install ii Engine ${engineUpdate.latest_version ?? ''}`.trim()}
                </button>
              ) : null}
              {engineUpdate?.outdated && !engineUpdate.can_install ? (
                <a
                  className="primary engine-update-link"
                  href={engineUpdate.release_url || engineReleasesUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={externalClick(engineUpdate.release_url || engineReleasesUrl)}
                >
                  <EngineIcon name="external" size={16} />
                  Open GitHub Releases
                </a>
              ) : null}
              {!engineUpdate?.outdated ? (
                <p className="engine-update-ok">
                  {engineUpdate
                    ? `Installed build v${engineUpdate.current_version}${
                        engineUpdate.latest_version
                          ? ` · newest published v${engineUpdate.latest_version}`
                          : ''
                      }`
                    : 'Waiting for the update check…'}
                </p>
              ) : null}
            </div>
          </section>

          <section className="engine-card system-check-card" aria-label="System check">
            <header className="engine-card-head">
              <EngineIcon name="document" size={17} className="head-glyph" />
              <div>
                <h2>System Check</h2>
                <p>
                  {report
                    ? issueChecks.length
                      ? 'Problems are listed first with the exact action or file involved.'
                      : release && !releaseMatches
                        ? 'Local files are healthy, but the selected menu release is not installed.'
                        : 'Gorilla Tag, BepInEx, and the selected menu passed verification.'
                    : 'Results appear here after ii Engine checks the installation.'}
                </p>
              </div>
              <div className="engine-card-head-actions">
                <span className="head-meta">Last scanned {lastScanLabel}</span>
                <button disabled={busy} onClick={() => void scan(undefined, { paced: true })}>
                  <EngineIcon name="refresh" size={15} /> Scan again
                </button>
              </div>
            </header>

            <div className="engine-rows">
              {(report ? coreChecks : []).map((check, index) => {
                const key = `${check.name}-${index}`;
                const open = expandedCheck === key;
                const ok = check.status === 'Healthy';
                const info =
                  check.name === 'Release integrity'
                    ? 'Informational — does not mark your install unhealthy.'
                    : check.name === 'Extra plugins'
                      ? 'Community mods are listed below. They are not repaired or flagged.'
                      : check.name === 'Game installation'
                        ? 'Required Gorilla Tag files under the selected Steam folder.'
                        : check.name === 'Loader version'
                          ? 'BepInEx 5.x LTS core DLL. Install prefers live GitHub; pinned backup is the fallback.'
                          : check.name === 'Menu copies'
                            ? 'Exactly one ii menu DLL identified by BepInPlugin GUID.'
                            : check.name === 'Game process'
                              ? 'Close Gorilla Tag before repair or install writes.'
                              : null;
                return (
                  <button
                    className={`engine-row ${ok ? 'ok' : 'warn'}`}
                    key={key}
                    onClick={() => setExpandedCheck(open ? null : key)}
                    aria-expanded={open}
                  >
                    <EngineIcon name={ok ? 'checkCircle' : 'wrench'} size={18} />
                    <span className="engine-row-label">{check.name}</span>
                    <span className="engine-row-copy">
                      <small>{check.detail}</small>
                      {info && <small className="engine-row-info">{info}</small>}
                      {open && <code>{check.status}</code>}
                    </span>
                    <span className={`engine-pill ${ok ? 'ok' : 'warn'}`}>
                      <i className="pill-dot" />
                      {ok ? 'Healthy' : check.status}
                    </span>
                    <EngineIcon
                      name="chevronDown"
                      size={16}
                      className={`engine-row-chevron ${open ? 'open' : ''}`}
                    />
                  </button>
                );
              })}
              {!report && (
                <p className="empty-row">
                  {demo
                    ? 'Open the Windows desktop app to inspect and repair local game files.'
                    : 'No scan results yet.'}
                </p>
              )}
              {report && !coreChecks.length && (
                <p className="empty-row">No detailed checks were returned.</p>
              )}
            </div>

            {!!menuDlls.length && (
              <details className="health-dll-details" open>
                <summary>ii menu DLLs ({menuDlls.length})</summary>
                {menuDlls.map((file) => (
                  <div className="check-row" key={file.name}>
                    <EngineIcon name="shield" size={17} />
                    <div>
                      <strong>{file.name}</strong>
                      <p>
                        ii menu assembly · {file.size.toLocaleString()} bytes
                        {file.plugins[0]?.version ? ` · v${file.plugins[0].version}` : ''}
                      </p>
                      <code>{file.sha256}</code>
                    </div>
                  </div>
                ))}
              </details>
            )}

            {!!extraDlls.length && (
              <details className="health-dll-details health-extra-dlls" open>
                <summary>Extra plugins (not repaired) · {extraDlls.length}</summary>
                <p className="health-extra-dlls-blurb">
                  These DLLs are outside the folders Engine repairs. They are normal for most mod
                  setups and are never marked unhealthy just for being unknown.
                </p>
                {extraDlls.map((file) => (
                  <div className="check-row" key={file.name}>
                    <EngineIcon name="puzzle" size={17} />
                    <div>
                      <strong>{file.name}</strong>
                      <p>
                        Extra plugin · {file.size.toLocaleString()} bytes
                        {file.plugins[0]?.name ? ` · ${file.plugins[0].name}` : ''}
                        {file.plugins[0]?.version ? ` v${file.plugins[0].version}` : ''}
                      </p>
                      <code>{file.sha256}</code>
                    </div>
                  </div>
                ))}
              </details>
            )}
          </section>

          <GameFilesBrowser
            demo={demo}
            isPro={isPro}
            gamePath={gamePath}
            onNeedGame={async () => {
              try {
                const detected = await detectGame();
                setGamePath(detected);
                return detected;
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : String(reason));
                return null;
              }
            }}
          />

          <AiModChecker demo={demo} />
        </div>

        <aside className="health-rail" aria-label="Health widgets">
          <section className="engine-card rail-widget" aria-label="Game health">
            <header className="engine-card-head">
              <EngineIcon name="health" size={17} className="head-glyph tone-success" />
              <div>
                <h3>Game Health</h3>
              </div>
              <span className={`engine-pill ${healthy ? 'ok' : 'warn'}`}>
                <i className="pill-dot" />
                {healthy ? 'Healthy' : report ? 'Attention' : 'Waiting'}
              </span>
            </header>
            <strong className="rail-verdict">
              {healthy ? 'All systems are healthy!' : report ? scanSummary : 'Ready to scan'}
            </strong>
            <p className="rail-explainer">
              {healthy
                ? 'Core game, loader, and ii menu checks passed. Extra community mods are ignored.'
                : report
                  ? issueChecks.length
                    ? 'Run Repair Automatically to restore the files listed in System Check.'
                    : 'Your last scan finished. Keep an eye on menu updates.'
                  : 'Run Scan for Issues to check Gorilla Tag, BepInEx, and ii.'}
            </p>
            <ul className="health-card-facts">
              <li>
                <EngineIcon name="play" size={14} />
                <span>
                  Game:{' '}
                  {gameCheck?.status === 'Healthy'
                    ? 'install found'
                    : gameCheck
                      ? gameCheck.status
                      : 'not scanned'}
                </span>
              </li>
              <li>
                <EngineIcon name="puzzle" size={14} />
                <span>
                  BepInEx:{' '}
                  {loaderVersion ? loaderVersion : loaderCheck ? loaderCheck.status : 'not scanned'}
                </span>
              </li>
              <li>
                <EngineIcon name="shield" size={14} />
                <span>
                  ii menu:{' '}
                  {installedMenuVersion
                    ? `v${installedMenuVersion}`
                    : menuCheck
                      ? menuCheck.status
                      : 'not scanned'}
                  {extraDlls.length ? ` · ${extraDlls.length} extra mods` : ''}
                </span>
              </li>
            </ul>
            <div className="health-stat-strip">
              <div>
                <strong>
                  {healthyChecks} / {coreChecks.length || 0}
                </strong>
                <small>Systems healthy</small>
              </div>
              <div>
                <strong>{issueChecks.length}</strong>
                <small>Issues found</small>
              </div>
              <div>
                <strong>{healthy ? 'Ready' : report ? 'Check' : '-'}</strong>
                <small>to launch</small>
              </div>
            </div>
            <div className="rail-pill-row">
              <span className={`engine-pill ${gameCheck?.status === 'Healthy' ? 'ok' : 'neutral'}`}>
                Gorilla Tag
              </span>
              {loaderVersion && (
                <span className="engine-pill neutral">BepInEx {loaderVersion}</span>
              )}
              {installedMenuVersion && (
                <span className={`engine-pill ${releaseMatches ? 'ok' : 'neutral'}`}>
                  ii menu {installedMenuVersion}
                </span>
              )}
              {extraDlls.length > 0 && (
                <span className="engine-pill neutral">{extraDlls.length} extra mods</span>
              )}
            </div>
            <span className="rail-meta">
              <EngineIcon name="clock" size={13} /> Last scan {lastScanLabel}
            </span>
          </section>

          <section className="engine-card rail-widget" aria-label="Quick actions">
            <header className="engine-card-head">
              <EngineIcon name="wrench" size={17} className="head-glyph" />
              <div>
                <h3>Quick Actions</h3>
                <p>Common maintenance tools.</p>
              </div>
            </header>
            <div className="engine-rows">
              {engineUpdate?.outdated && (
                <button
                  className="engine-row action"
                  disabled={busy || engineUpdateBusy || demo}
                  onClick={() => {
                    if (engineUpdate.can_install) {
                      void installEngineUpdate();
                      return;
                    }
                    void openExternal(engineUpdate.release_url || engineReleasesUrl);
                  }}
                >
                  <EngineIcon name="download" size={18} />
                  <span className="engine-row-copy">
                    <strong>
                      {engineUpdate.can_install
                        ? `Install ii Engine ${engineUpdate.latest_version ?? ''}`.trim()
                        : 'Get the latest ii Engine'}
                    </strong>
                    <small>{engineUpdate.detail}</small>
                  </span>
                  <EngineIcon name="chevronRight" size={15} className="engine-row-chevron" />
                </button>
              )}
              <button
                className="engine-row action"
                disabled={busy || demo || !gamePath}
                onClick={() => void openFolder('open_game_folder')}
              >
                <EngineIcon name="folder" size={18} />
                <span className="engine-row-copy">
                  <strong>Open game folder</strong>
                  <small>Jump to the detected Gorilla Tag install.</small>
                </span>
                <EngineIcon name="chevronRight" size={15} className="engine-row-chevron" />
              </button>
              <button
                className="engine-row action"
                disabled={busy || demo || !gamePath}
                onClick={() => void openFolder('open_ii_folder')}
              >
                <EngineIcon name="external" size={18} />
                <span className="engine-row-copy">
                  <strong>Open ii folder</strong>
                  <small>Inspect installed plugins and settings.</small>
                </span>
                <EngineIcon name="chevronRight" size={15} className="engine-row-chevron" />
              </button>
              <button
                className="engine-row action"
                disabled={busy || demo || !gamePath}
                onClick={() => void prepareReset()}
              >
                <EngineIcon name="refresh" size={18} />
                <span className="engine-row-copy">
                  <strong>Reset ii settings</strong>
                  <small>Back up, then restore menu defaults.</small>
                </span>
                <EngineIcon name="chevronRight" size={15} className="engine-row-chevron" />
              </button>
            </div>
          </section>

          <section className="engine-card rail-widget" aria-label="Need help">
            <header className="engine-card-head">
              <EngineIcon name="help" size={17} className="head-glyph tone-info" />
              <div>
                <h3>Need Help?</h3>
                <p>Having issues? Try these resources.</p>
              </div>
            </header>
            <div className="engine-rows">
              <a
                className="engine-row action"
                href={official}
                target="_blank"
                rel="noreferrer"
                onClick={externalClick(official)}
              >
                <EngineIcon name="discord" size={18} />
                <span className="engine-row-copy">
                  <strong>Join our Discord</strong>
                  <small>Support, guides, and release news.</small>
                </span>
                <EngineIcon name="external" size={14} className="engine-row-chevron" />
              </a>
              <a
                className="engine-row action"
                href={official}
                target="_blank"
                rel="noreferrer"
                onClick={externalClick(official)}
              >
                <EngineIcon name="lightbulb" size={18} />
                <span className="engine-row-copy">
                  <strong>Get help with a repair</strong>
                  <small>Ask staff before a clean reinstall.</small>
                </span>
                <EngineIcon name="external" size={14} className="engine-row-chevron" />
              </a>
              {navigate && (
                <button className="engine-row action" onClick={() => navigate('Community')}>
                  <EngineIcon name="news" size={18} />
                  <span className="engine-row-copy">
                    <strong>Check Community announcements</strong>
                    <small>Known issues and menu updates.</small>
                  </span>
                  <EngineIcon name="chevronRight" size={15} className="engine-row-chevron" />
                </button>
              )}
            </div>
          </section>
        </aside>
      </div>

      {resetPreview && (
        <section className="panel destructive-review" aria-label="Settings reset review">
          <h3>Confirm ii settings reset</h3>
          <p>
            This will back up and remove only the <strong>iisStupidMenu</strong> settings folder (ii
            Reborn Menu). It will not remove unrelated mods or their settings. Up to{' '}
            {resetPreview.backup_bytes.toLocaleString()} bytes will be backed up first.
          </p>
          <label className="check-choice">
            <input
              type="checkbox"
              checked={resetConfirmed}
              onChange={(event) => setResetConfirmed(event.target.checked)}
            />
            I understand that ii&apos;s local settings will be reset after the backup is created.
          </label>
          <div className="developer-toolbar">
            <button
              className="primary"
              disabled={busy || !resetConfirmed}
              onClick={() => void executeReset()}
            >
              Back up and reset settings
            </button>
            <button disabled={busy} onClick={() => setResetPreview(null)}>
              Cancel
            </button>
          </div>
        </section>
      )}

      {cleanResetOpen && (
        <section className="panel destructive-review" aria-label="Clean reinstall review">
          <h3>Confirm clean Gorilla Tag reinstall</h3>
          <p>
            This permanently removes every file inside the detected Gorilla Tag installation,
            including all mods and local files. The BepInEx plugins folder is backed up first. Steam
            will then open its uninstall prompt; after you confirm it, ii Engine will open the Steam
            install prompt and finish the BepInEx and ii setup.
          </p>
          <label>
            Type <strong>RESET GORILLA TAG</strong> to continue
            <input
              value={cleanResetConfirmation}
              onChange={(event) => setCleanResetConfirmation(event.target.value)}
              autoComplete="off"
            />
          </label>
          <div className="developer-toolbar">
            <button
              className="danger"
              disabled={busy || cleanResetConfirmation !== 'RESET GORILLA TAG'}
              onClick={() => void beginCleanReinstall()}
            >
              Remove and reinstall Gorilla Tag
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setCleanResetOpen(false);
                setCleanResetConfirmation('');
              }}
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {!!cleanResetBackup && (
        <section className="panel destructive-review" aria-label="Steam uninstall confirmation">
          <h3>Confirm Steam has removed Gorilla Tag</h3>
          <p>
            Plugin backup: <code>{cleanResetBackup}</code>. Confirm Steam&apos;s uninstall prompt,
            then continue. ii Engine will ask Steam to install a clean copy, restore BepInEx, and
            create its empty plugins folder.
          </p>
          <div className="developer-toolbar">
            <button
              className="primary"
              disabled={busy}
              onClick={() => void continueCleanReinstall()}
            >
              Continue with Steam reinstall
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
