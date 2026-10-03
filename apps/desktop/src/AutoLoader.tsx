import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { motion } from 'motion/react';
import {
  Bot,
  Download,
  HardDrive,
  Layers,
  MoreHorizontal,
  PackageCheck,
  Plus,
  Power,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { apiRequest, errorMessage } from './api';
import { detectGame } from './launcher';
import { ModThumbnail } from './ModThumbnail';
import { modUploadPayload } from './modUpload';
import PageHero from './PageHero';
import { trackFeature } from './telemetry';
import { COMMUNITY_MOD_ACCESS_ROLE_ID, TRUSTED_CREATOR_ROLE_ID } from './featureAccess';
import LoadoutsPanel from './LoadoutsPanel';
import { ModVoteButtons, type VoteInfo } from './ModVotes';
import type { LoadoutModRef, ModLoadout } from './loadouts';

type TrustedMod = {
  id: string;
  name: string;
  description: string;
  filename: string;
  sha256: string;
  byte_size: number;
  created_at: string;
  has_thumbnail?: boolean;
  thumbnail_url?: string | null;
  votes?: VoteInfo;
};

type InstalledMod = {
  filename: string;
  relative_path: string;
  byte_size: number;
  sha256: string;
  enabled: boolean;
};

type Identity = { id: string; display_name: string; avatar: string | null };
type CommunityMod = {
  id: string;
  name: string;
  description: string;
  filename: string;
  sha256: string;
  byte_size: number;
  created_at: string;
  author: Identity;
  has_thumbnail?: boolean;
  thumbnail_url?: string | null;
  ai_info_status?: string;
  has_ai_info?: boolean;
  votes?: VoteInfo;
};

type CommunityAiInfo = {
  id: string;
  status: string;
  report: string | null;
  error: string;
  updated_at: string | null;
  disclaimer: string;
};
type CreatorStatus = {
  can_post: boolean;
  can_publish_trusted?: boolean;
  role_id: string;
  trusted_role_id?: string;
  pending: { id: string; status: string } | null;
  latest: { id: string; status: string; review_note: string } | null;
};

const size = (bytes: number) =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(2)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function modTags(mod: TrustedMod) {
  const tags = ['Plugin', 'DLL'];
  const name = `${mod.name} ${mod.description}`.toLowerCase();
  if (name.includes('overlay') || name.includes('ui')) tags.push('UI');
  if (name.includes('util')) tags.push('Utilities');
  if (name.includes('sound') || name.includes('audio')) tags.push('Audio');
  if (name.includes('walk') || name.includes('move')) tags.push('Movement');
  if (!tags.includes('Utilities') && !tags.includes('UI') && !tags.includes('Audio')) {
    tags.push('Utilities');
  }
  return tags.slice(0, 4);
}

function Avatar({ person }: { person: Identity }) {
  return person.avatar ? (
    <img className="community-avatar" src={person.avatar} alt="" />
  ) : (
    <span className="community-avatar fallback">{person.display_name.slice(0, 1)}</span>
  );
}

export default function AutoLoader({ demo, isPro = false }: { demo: boolean; isPro?: boolean }) {
  const [tab, setTab] = useState<'trusted' | 'community' | 'installed' | 'loadouts'>(() => {
    try {
      const hint = sessionStorage.getItem('ii-mod-library-tab');
      if (hint === 'loadouts') {
        sessionStorage.removeItem('ii-mod-library-tab');
        return 'loadouts';
      }
    } catch {}
    return 'trusted';
  });
  const [catalog, setCatalog] = useState<TrustedMod[]>([]);
  const [community, setCommunity] = useState<CommunityMod[]>([]);
  const [creator, setCreator] = useState<CreatorStatus | null>(null);
  const [installed, setInstalled] = useState<InstalledMod[]>([]);
  const [gamePath, setGamePath] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [toast, setToast] = useState('');
  const toastTimer = useRef<number | null>(null);
  const [error, setError] = useState('');

  const flashInstall = useCallback((message: string) => {
    setNotice(message);
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2800);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, []);
  const [armedRemove, setArmedRemove] = useState('');
  const [search, setSearch] = useState('');
  const [menuOpen, setMenuOpen] = useState('');
  const [modName, setModName] = useState('');
  const [modDescription, setModDescription] = useState('');
  const [modFile, setModFile] = useState<File | null>(null);
  const [modThumb, setModThumb] = useState<File | null>(null);
  const [aiInfoMod, setAiInfoMod] = useState<CommunityMod | null>(null);
  const [aiInfo, setAiInfo] = useState<CommunityAiInfo | null>(null);
  const [aiInfoBusy, setAiInfoBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError('');
    if (demo) {
      setCatalog([
        {
          id: 'demo-trusted-mod',
          name: 'Demo Trusted Platforms',
          description: 'Sample trusted mod for votes and loadouts in the local demo.',
          filename: 'DemoTrustedPlatforms.dll',
          sha256: '1'.repeat(64),
          byte_size: 32_000,
          created_at: new Date().toISOString(),
          votes: { upvotes: 4, downvotes: 1, score: 3, my_vote: 0 },
        },
      ]);
      setCommunity([
        {
          id: 'demo-community-mod',
          name: 'Demo Community Utility',
          description: 'Sample approved community mod for trying the AI info brief panel.',
          filename: 'DemoCommunityUtility.dll',
          sha256: '0'.repeat(64),
          byte_size: 48_000,
          created_at: new Date().toISOString(),
          author: { id: 'demo-author', display_name: 'Demo Creator', avatar: null },
          ai_info_status: 'ready',
          has_ai_info: true,
          votes: { upvotes: 2, downvotes: 0, score: 2, my_vote: 0 },
        },
      ]);
      setCreator({
        can_post: false,
        can_publish_trusted: false,
        role_id: COMMUNITY_MOD_ACCESS_ROLE_ID,
        trusted_role_id: TRUSTED_CREATOR_ROLE_ID,
        pending: null,
        latest: null,
      });
      return;
    }
    try {
      const [catalogResponse, communityResponse, creatorResponse, detected] = await Promise.all([
        apiRequest('/v1/trusted-mods'),
        apiRequest('/v1/community/mods').catch(() => null),
        apiRequest('/v1/community/creator-status').catch(() => null),
        isTauri() ? (gamePath ? Promise.resolve(gamePath) : detectGame()) : Promise.resolve(''),
      ]);
      const payload = (await catalogResponse.json()) as { items: TrustedMod[] };
      const items = Array.isArray(payload.items) ? payload.items : [];
      setCatalog(items);
      if (communityResponse) {
        const communityPayload = (await communityResponse.json()) as { items: CommunityMod[] };
        setCommunity(Array.isArray(communityPayload.items) ? communityPayload.items : []);
      }
      if (creatorResponse) {
        setCreator((await creatorResponse.json()) as CreatorStatus);
      }
      if (isTauri() && detected) {
        const local = await invoke<InstalledMod[]>('list_installed_mods', { gamePath: detected });
        setInstalled(local);
        setGamePath(detected);
      }
    } catch (reason) {
      setCatalog([]);
      setError(errorMessage(reason, 'Could not load the mod catalog.'));
    }
  }, [demo, gamePath]);

  useEffect(() => {
    trackFeature('mod_library', 'open');
    void refresh();
  }, [refresh]);

  const installedHashes = useMemo(
    () => new Set(installed.map((item) => item.sha256.toLowerCase())),
    [installed],
  );
  const term = search.trim().toLowerCase();
  const visibleCatalog = useMemo(
    () =>
      catalog.filter(
        (mod) =>
          !term || `${mod.name} ${mod.description} ${mod.filename}`.toLowerCase().includes(term),
      ),
    [catalog, term],
  );
  const visibleCommunity = useMemo(
    () =>
      community.filter(
        (mod) =>
          !term ||
          `${mod.name} ${mod.description} ${mod.filename} ${mod.author.display_name}`
            .toLowerCase()
            .includes(term),
      ),
    [community, term],
  );
  const visibleInstalled = useMemo(
    () =>
      installed.filter(
        (mod) => !term || `${mod.filename} ${mod.relative_path}`.toLowerCase().includes(term),
      ),
    [installed, term],
  );

  async function install(mod: TrustedMod) {
    if (!gamePath) return;
    setBusy(mod.id);
    setError('');
    setNotice(`Downloading and verifying ${mod.name}…`);
    try {
      const response = await apiRequest(`/v1/trusted-mods/${encodeURIComponent(mod.id)}/ticket`, {
        method: 'POST',
      });
      const ticket = (await response.json()) as { download_url: string };
      await invoke('install_trusted_mod', {
        gamePath,
        filename: mod.filename,
        sha256: mod.sha256,
        downloadUrl: ticket.download_url,
      });
      trackFeature('mod_library', `install:${mod.name}`);
      flashInstall(`${mod.name} installed`);
      await refresh();
    } catch (reason) {
      setNotice('');
      setError(errorMessage(reason, `Could not install ${mod.name}.`));
    } finally {
      setBusy('');
    }
  }

  async function remove(mod: InstalledMod) {
    if (armedRemove !== mod.relative_path) {
      setArmedRemove(mod.relative_path);
      return;
    }
    setBusy(mod.relative_path);
    setError('');
    try {
      await invoke('remove_installed_mod', { gamePath, relativePath: mod.relative_path });
      setArmedRemove('');
      flashInstall(`${mod.filename} removed`);
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason, `Could not remove ${mod.filename}.`));
    } finally {
      setBusy('');
    }
  }

  async function importLocal(file?: File | null) {
    if (!file || !gamePath) return;
    setBusy('local-import');
    setError('');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await invoke('import_local_mod', { gamePath, filename: file.name, bytes });
      flashInstall(`${file.name} installed locally`);
      await refresh();
    } catch (reason) {
      setNotice('');
      setError(errorMessage(reason, `Could not import ${file.name}.`));
    } finally {
      setBusy('');
    }
  }

  async function toggle(mod: InstalledMod) {
    setBusy(`toggle:${mod.relative_path}`);
    setError('');
    try {
      await invoke('set_installed_mod_enabled', {
        gamePath,
        relativePath: mod.relative_path,
        enabled: !mod.enabled,
      });
      setNotice(`${mod.filename} is now ${mod.enabled ? 'disabled' : 'enabled'}.`);
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason, `Could not change ${mod.filename}.`));
    } finally {
      setBusy('');
    }
  }

  async function uploadCommunity(event: FormEvent) {
    event.preventDefault();
    if (!modFile || !modName.trim() || !modDescription.trim() || demo) return;
    setBusy('community-upload');
    try {
      const query = new URLSearchParams({
        name: modName.trim(),
        description: modDescription.trim(),
        filename: modFile.name,
      });
      const { headers, body } = await modUploadPayload(modFile, modThumb);
      await apiRequest(`/v1/community/mods?${query}`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(120_000),
      });
      trackFeature('community_mods', 'upload');
      setModName('');
      setModDescription('');
      setModFile(null);
      setModThumb(null);
      setNotice(
        'Submitted for review. Developers see it under Developer → Pending mod reviews; it appears in Community mods after approval.',
      );
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason, 'Could not submit this DLL for review.'));
    } finally {
      setBusy('');
    }
  }

  async function uploadTrusted(event: FormEvent) {
    event.preventDefault();
    if (!modFile || !modName.trim() || !modDescription.trim() || demo) return;
    setBusy('trusted-upload');
    try {
      const query = new URLSearchParams({
        name: modName.trim(),
        description: modDescription.trim(),
        filename: modFile.name,
      });
      const { headers, body } = await modUploadPayload(modFile, modThumb);
      await apiRequest(`/v1/trusted-mods/publish?${query}`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(120_000),
      });
      trackFeature('mod_library', 'trusted_upload');
      setModName('');
      setModDescription('');
      setModFile(null);
      setModThumb(null);
      setNotice('Trusted mod published.');
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason, 'Could not publish this trusted mod.'));
    } finally {
      setBusy('');
    }
  }

  async function openCommunityAiInfo(mod: CommunityMod) {
    setAiInfoMod(mod);
    setAiInfo(null);
    setAiInfoBusy(true);
    setError('');
    try {
      if (demo) {
        setAiInfo({
          id: mod.id,
          status: 'ready',
          report: [
            '**Overview**',
            'Demo informational brief for a community mod. Sign in on desktop for live AI reviews.',
            '**Apparent Features**',
            '- Sample gameplay/utility behavior',
            '**Technical Notes**',
            '- Not evaluated in demo mode',
            '**Known History**',
            '- No prior catalog history was supplied.',
            '**Community Caution**',
            'Potentially malicious (unsigned community DLL). This is a general caution, not a guilt verdict.',
            '**Footnote**',
            'AI reviews can be wrong and are not perfect. Treat this as informal information only.',
          ].join('\n'),
          error: '',
          updated_at: new Date().toISOString(),
          disclaimer:
            'AI reviews can be wrong and are not perfect. This brief is informational only and never proves a community mod is safe. Treat community DLLs as potentially malicious.',
        });
        return;
      }
      const response = await apiRequest(`/v1/community/mods/${encodeURIComponent(mod.id)}/ai-info`);
      setAiInfo((await response.json()) as CommunityAiInfo);
      trackFeature('community_mods', 'ai_info');
    } catch (reason) {
      setError(errorMessage(reason, 'Could not load the AI info brief.'));
      setAiInfoMod(null);
    } finally {
      setAiInfoBusy(false);
    }
  }

  async function downloadCommunity(mod: CommunityMod) {
    try {
      const response = await apiRequest(`/v1/community/mods/${mod.id}/download`);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = mod.filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      trackFeature('community_mods', 'download');
    } catch (reason) {
      setError(errorMessage(reason, 'Could not download this DLL.'));
    }
  }

  function patchVotes(targetType: 'trusted' | 'community', id: string, votes: VoteInfo) {
    if (targetType === 'trusted') {
      setCatalog((current) => current.map((item) => (item.id === id ? { ...item, votes } : item)));
    } else {
      setCommunity((current) =>
        current.map((item) => (item.id === id ? { ...item, votes } : item)),
      );
    }
  }

  const loadoutCatalog: LoadoutModRef[] = useMemo(
    () => [
      ...catalog.map((mod) => ({
        source: 'trusted' as const,
        id: mod.id,
        name: mod.name,
        filename: mod.filename,
      })),
      ...community.map((mod) => ({
        source: 'community' as const,
        id: mod.id,
        name: mod.name,
        filename: mod.filename,
      })),
    ],
    [catalog, community],
  );

  async function applyLoadout(loadout: ModLoadout) {
    if (demo || !isTauri()) {
      setNotice('Applying loadouts requires the Windows desktop app.');
      return;
    }
    setBusy(`loadout-${loadout.id}`);
    setError('');
    try {
      const detected = gamePath || (await detectGame());
      setGamePath(detected);
      for (const mod of loadout.mods) {
        if (mod.source === 'trusted') {
          const full = catalog.find((item) => item.id === mod.id);
          if (!full) continue;
          const response = await apiRequest(
            `/v1/trusted-mods/${encodeURIComponent(full.id)}/ticket`,
            {
              method: 'POST',
            },
          );
          const ticket = (await response.json()) as { download_url: string };
          await invoke('install_trusted_mod', {
            gamePath: detected,
            filename: full.filename,
            sha256: full.sha256,
            downloadUrl: ticket.download_url,
          });
        } else {
          const full = community.find((item) => item.id === mod.id);
          if (!full) continue;
          const response = await apiRequest(
            `/v1/community/mods/${encodeURIComponent(full.id)}/download`,
            { signal: AbortSignal.timeout(120_000) },
          );
          const bytes = new Uint8Array(await response.arrayBuffer());
          await invoke('import_local_mod', {
            gamePath: detected,
            filename: full.filename,
            bytes,
          });
        }
      }
      flashInstall(`Applied loadout “${loadout.name}”.`);
      trackFeature('loadouts', 'applied');
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason, 'Could not apply that loadout.'));
    } finally {
      setBusy('');
    }
  }

  async function installCommunity(mod: CommunityMod) {
    if (!isTauri() || demo) {
      setError('Install community mods from the Windows desktop app.');
      return;
    }
    if (!gamePath) {
      setError('Select a Gorilla Tag install before installing community mods.');
      return;
    }
    setBusy(mod.id);
    setError('');
    setNotice(`Installing ${mod.name}…`);
    try {
      const response = await apiRequest(`/v1/community/mods/${mod.id}/download`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      await invoke('import_local_mod', {
        gamePath,
        filename: mod.filename,
        bytes,
      });
      trackFeature('community_mods', 'install');
      flashInstall(`${mod.name} installed`);
      await refresh();
    } catch (reason) {
      setNotice('');
      setError(errorMessage(reason, `Could not install ${mod.name}.`));
    } finally {
      setBusy('');
    }
  }

  const hero = (
    <PageHero
      label="Mod Library"
      className="autoloader-hero-banner"
      title="Mod Library"
      subtitle="Find, install, and manage Gorilla Tag mods."
      words={['MOD', 'CUSTOMIZE', 'EXPLORE']}
    />
  );

  return (
    <div className="autoloader-layout">
      {hero}
      {toast && (
        <div className="mod-install-toast" role="status" aria-live="polite">
          <PackageCheck size={16} />
          {toast}
        </div>
      )}
      {(error || notice) && (
        <div className={`operation-banner ${error ? 'error' : 'success'}`} role="status">
          {error || notice}
        </div>
      )}

      <div className="mod-library-tabs" role="tablist">
        <button
          className={tab === 'trusted' ? 'active' : ''}
          onClick={() => setTab('trusted')}
          role="tab"
          aria-selected={tab === 'trusted'}
        >
          <ShieldCheck size={15} /> Trusted
        </button>
        <button
          className={tab === 'community' ? 'active' : ''}
          onClick={() => setTab('community')}
          role="tab"
          aria-selected={tab === 'community'}
        >
          <Users size={15} /> Community
        </button>
        <button
          className={tab === 'installed' ? 'active' : ''}
          onClick={() => setTab('installed')}
          role="tab"
          aria-selected={tab === 'installed'}
        >
          <HardDrive size={15} /> Installed
        </button>
        {isPro && (
          <button
            className={tab === 'loadouts' ? 'active' : ''}
            onClick={() => setTab('loadouts')}
            role="tab"
            aria-selected={tab === 'loadouts'}
          >
            <Layers size={15} /> Loadouts
          </button>
        )}
      </div>

      <div className="mod-search-row">
        <label className="mod-search">
          <Search size={18} />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search mods…"
            aria-label="Search mods"
          />
          {search && <button onClick={() => setSearch('')}>Clear</button>}
        </label>
        <button disabled={!!busy} onClick={() => void refresh()} aria-label="Refresh catalog">
          <RefreshCw size={16} />
        </button>
      </div>

      {tab === 'trusted' && (
        <section className="panel featured-catalog">
          <div className="section-heading-row">
            <div>
              <span className="eyebrow">FEATURED</span>
              <h3>Trusted Catalog</h3>
              <p>Mods from trusted creators. We check them before they go up.</p>
            </div>
            <span className="status-pill">{catalog.length} mods</span>
          </div>

          <div className="mod-plan-banner">
            <ShieldCheck size={18} />
            <div>
              <strong>Trusted catalog · unlimited installs</strong>
              <p>
                Install verified library mods with no plan cap. Pro still unlocks Customize and
                Studio Pro.
              </p>
            </div>
          </div>

          {creator?.can_publish_trusted && (
            <form
              className="panel community-upload trusted-creator-upload"
              onSubmit={uploadTrusted}
            >
              <h3>Publish a trusted mod</h3>
              <p>
                Your Trusted Mod Creator role lets you upload to this catalog. Optional thumbnail
                appears on the card; otherwise a black plate with the mod name is used.
              </p>
              <input
                placeholder="Mod name"
                maxLength={120}
                value={modName}
                onChange={(event) => setModName(event.target.value)}
              />
              <textarea
                placeholder="Short description"
                maxLength={1000}
                value={modDescription}
                onChange={(event) => setModDescription(event.target.value)}
              />
              <label className="file-pick">
                <Upload size={16} />
                <span>{modFile ? modFile.name : 'Choose DLL'}</span>
                <input
                  type="file"
                  accept=".dll,application/x-msdownload"
                  onChange={(event) => setModFile(event.target.files?.[0] ?? null)}
                />
              </label>
              <label className="file-pick">
                <Upload size={16} />
                <span>{modThumb ? modThumb.name : 'Optional thumbnail (JPG/PNG/WebP)'}</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(event) => setModThumb(event.target.files?.[0] ?? null)}
                />
              </label>
              <button
                className="primary"
                disabled={!!busy || demo || !modFile || !modName.trim() || !modDescription.trim()}
              >
                {busy === 'trusted-upload' ? 'Publishing…' : 'Publish to Trusted'}
              </button>
            </form>
          )}

          <div className="trusted-mod-grid">
            {visibleCatalog.map((mod, index) => {
              const present = installedHashes.has(mod.sha256.toLowerCase());
              const tags = modTags(mod);
              return (
                <motion.article
                  className="mod-catalog-card"
                  key={mod.id}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(index, 8) * 0.04, type: 'spring', stiffness: 360 }}
                >
                  <div className="trusted-mod-media">
                    <ModThumbnail path={mod.thumbnail_url} name={mod.name} />
                    <span className="verified-pill">
                      <PackageCheck size={12} /> Verified
                    </span>
                  </div>
                  <div className="trusted-mod-body">
                    <h4>{mod.name}</h4>
                    <p>{mod.description}</p>
                    <div className="mod-tags">
                      {tags.map((tag) => (
                        <span key={tag}>{tag}</span>
                      ))}
                      <span>{size(mod.byte_size)}</span>
                    </div>
                    <div className="mod-card-meta">
                      <small>
                        <Download size={13} /> {size(mod.byte_size)}
                      </small>
                      <small title={mod.sha256}>SHA {mod.sha256.slice(0, 8)}</small>
                    </div>
                    <ModVoteButtons
                      targetType="trusted"
                      targetId={mod.id}
                      votes={mod.votes}
                      demo={demo}
                      disabled={!!busy}
                      onChange={(votes) => patchVotes('trusted', mod.id, votes)}
                      onError={setError}
                    />
                    <button
                      className={present ? '' : 'primary'}
                      disabled={!!busy || present || demo || !isTauri()}
                      title={
                        demo || !isTauri()
                          ? 'Install from the desktop app'
                          : present
                            ? 'Already installed'
                            : `Install ${mod.filename}`
                      }
                      onClick={() => void install(mod)}
                    >
                      {busy === mod.id ? (
                        'Installing…'
                      ) : present ? (
                        'Installed'
                      ) : demo || !isTauri() ? (
                        'Desktop install'
                      ) : (
                        <>
                          <Plus size={15} /> Install
                        </>
                      )}
                    </button>
                  </div>
                </motion.article>
              );
            })}
            {!visibleCatalog.length && (
              <p className="empty-row">
                {term
                  ? 'No available mods match your search.'
                  : 'No trusted mods are published yet. Trusted Mod Creators can upload here.'}
              </p>
            )}
          </div>
        </section>
      )}

      {tab === 'community' && (
        <div className="community-mods-tab">
          <div className="community-disclaimer" role="note">
            <ShieldAlert size={20} />
            <div>
              <strong>Submit any DLL for review.</strong>
              <p>
                Anyone can send a community mod in. It goes to Developer → Pending mod reviews.
                Approved mods land in this list. ii Engine still does not endorse community files.
              </p>
            </div>
          </div>

          <form className="panel community-upload" onSubmit={uploadCommunity}>
            <h3>Send a mod for review</h3>
            <input
              placeholder="Mod name"
              maxLength={120}
              value={modName}
              onChange={(event) => setModName(event.target.value)}
            />
            <textarea
              placeholder="What does it do?"
              maxLength={1000}
              value={modDescription}
              onChange={(event) => setModDescription(event.target.value)}
            />
            <label className="file-pick">
              <Upload size={16} />
              <span>{modFile ? modFile.name : 'Choose DLL'}</span>
              <input
                type="file"
                accept=".dll"
                onChange={(event) => setModFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <label className="file-pick">
              <Upload size={16} />
              <span>{modThumb ? modThumb.name : 'Optional thumbnail (JPG/PNG/WebP)'}</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(event) => setModThumb(event.target.files?.[0] ?? null)}
              />
            </label>
            <button
              className="primary"
              disabled={!!busy || demo || !modFile || !modName.trim() || !modDescription.trim()}
            >
              <Upload size={16} />{' '}
              {busy === 'community-upload' ? 'Submitting…' : 'Submit for review'}
            </button>
          </form>

          <div className="community-mod-grid">
            {visibleCommunity.map((mod, index) => (
              <motion.article
                className="panel community-mod-card"
                key={mod.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(index, 8) * 0.03 }}
              >
                <ModThumbnail
                  path={mod.thumbnail_url}
                  name={mod.name}
                  className="community-mod-thumb"
                />
                <div className="community-mod-author">
                  <Avatar person={mod.author} />
                  <span>
                    Shared by <strong>{mod.author.display_name}</strong>
                  </span>
                </div>
                <h3>{mod.name}</h3>
                <p>{mod.description}</p>
                <code title={mod.filename}>{mod.filename}</code>
                <small>
                  {size(mod.byte_size)} · SHA-256 {mod.sha256.slice(0, 12)}…
                </small>
                <ModVoteButtons
                  targetType="community"
                  targetId={mod.id}
                  votes={mod.votes}
                  demo={demo}
                  disabled={!!busy}
                  onChange={(votes) => patchVotes('community', mod.id, votes)}
                  onError={setError}
                />
                <div className="community-mod-actions">
                  <button
                    className="primary"
                    disabled={!!busy || demo || !isTauri() || !gamePath}
                    onClick={() => void installCommunity(mod)}
                  >
                    <PackageCheck size={16} /> {busy === mod.id ? 'Installing…' : 'Install'}
                  </button>
                  <button
                    disabled={!!busy || aiInfoBusy}
                    onClick={() => void openCommunityAiInfo(mod)}
                  >
                    <Bot size={16} /> AI info
                  </button>
                  <button disabled={!!busy} onClick={() => void downloadCommunity(mod)}>
                    <Download size={16} /> Download DLL
                  </button>
                </div>
                {mod.ai_info_status &&
                  mod.ai_info_status !== 'ready' &&
                  mod.ai_info_status !== 'idle' && (
                    <small className="community-ai-status">AI brief: {mod.ai_info_status}</small>
                  )}
              </motion.article>
            ))}
            {!visibleCommunity.length && (
              <p className="empty-row">
                {term
                  ? 'No community mods match your search.'
                  : 'No approved community mods yet. Submit one above for review.'}
              </p>
            )}
          </div>
        </div>
      )}

      {aiInfoMod &&
        createPortal(
          <div className="tutorial-backdrop community-ai-backdrop">
            <section
              className="tutorial-card community-ai-panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby="community-ai-title"
            >
              <header className="community-ai-panel-head">
                <div>
                  <span className="eyebrow">
                    <Bot size={14} /> AI INFO BRIEF
                  </span>
                  <h2 id="community-ai-title">{aiInfoMod.name}</h2>
                  <p>Informational only — not a malware score or safety guarantee.</p>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Close AI info"
                  onClick={() => {
                    setAiInfoMod(null);
                    setAiInfo(null);
                  }}
                >
                  <X size={18} />
                </button>
              </header>
              {aiInfoBusy && <p role="status">Loading AI brief…</p>}
              {aiInfo && (
                <>
                  <p className="disclaimer community-ai-disclaimer" role="note">
                    <ShieldAlert size={14} /> {aiInfo.disclaimer}
                  </p>
                  {aiInfo.status !== 'ready' && (
                    <p role="status">
                      Status: {aiInfo.status}
                      {aiInfo.error ? ` — ${aiInfo.error}` : ''}
                    </p>
                  )}
                  {aiInfo.report ? (
                    <pre className="ai-mod-report community-ai-report" role="document">
                      {aiInfo.report}
                    </pre>
                  ) : (
                    !aiInfoBusy && (
                      <p className="empty-row">
                        No AI brief yet. Approved community mods are scanned automatically after
                        review.
                      </p>
                    )
                  )}
                  <p className="community-ai-footnote">
                    AI reviews can be wrong and aren’t perfect. Treat every community DLL as
                    potentially malicious.
                  </p>
                </>
              )}
            </section>
          </div>,
          document.body,
        )}

      {tab === 'installed' && (
        <section className="panel">
          <div className="section-heading-row">
            <div>
              <span className="eyebrow">LOCAL PLUGINS</span>
              <h3>Installed DLLs</h3>
              <p>Enable, disable, or remove plugins in your BepInEx folder.</p>
            </div>
            <div className="local-mod-actions">
              {isTauri() && !demo && (
                <label className="button local-mod-import">
                  <Upload size={15} /> {busy === 'local-import' ? 'Importing…' : 'Import local DLL'}
                  <input
                    type="file"
                    accept=".dll,application/octet-stream"
                    disabled={!!busy || !gamePath}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      void importLocal(file);
                    }}
                  />
                </label>
              )}
              <span className="status-pill">{installed.length} found</span>
            </div>
          </div>
          {gamePath && (
            <p className="path-summary">
              <HardDrive size={15} /> {gamePath}\BepInEx\plugins
            </p>
          )}
          {demo || !isTauri() ? (
            <p className="empty-row">Local plugin management stays inside the desktop app.</p>
          ) : (
            <div className="installed-mod-list">
              {visibleInstalled.map((mod) => (
                <article className={mod.enabled ? '' : 'disabled-mod'} key={mod.relative_path}>
                  <div className="installed-mod-icon" aria-hidden="true">
                    <PackageCheck size={18} />
                  </div>
                  <div>
                    <strong>
                      {mod.filename.replace(/\.dll$/i, '')}
                      <span className={`enabled-pill ${mod.enabled ? '' : 'off'}`}>
                        {mod.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                      <span className="mod-info-pill">DLL</span>
                      <span className="mod-info-pill">{size(mod.byte_size)}</span>
                    </strong>
                    <small>
                      {mod.relative_path} · SHA {mod.sha256.slice(0, 8)}
                    </small>
                  </div>
                  <div className="installed-mod-actions">
                    <div className="mod-overflow">
                      <button
                        className="icon-button"
                        aria-label={`More options for ${mod.filename}`}
                        onClick={() =>
                          setMenuOpen((value) =>
                            value === mod.relative_path ? '' : mod.relative_path,
                          )
                        }
                      >
                        <MoreHorizontal size={16} />
                      </button>
                      {menuOpen === mod.relative_path && (
                        <div className="mod-overflow-menu">
                          <button
                            className={armedRemove === mod.relative_path ? 'danger-button' : ''}
                            disabled={!!busy}
                            onClick={() => void remove(mod)}
                          >
                            <Trash2 size={15} />
                            {busy === mod.relative_path
                              ? 'Removing…'
                              : armedRemove === mod.relative_path
                                ? 'Confirm remove'
                                : 'Remove'}
                          </button>
                        </div>
                      )}
                    </div>
                    <button disabled={!!busy} onClick={() => void toggle(mod)}>
                      <Power size={15} /> {mod.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </div>
                </article>
              ))}
              {!visibleInstalled.length && (
                <p className="empty-row">
                  {term ? 'No installed mods match your search.' : 'No plugin DLLs were found.'}
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {tab === 'loadouts' && isPro && (
        <LoadoutsPanel
          catalog={loadoutCatalog}
          onApply={(loadout) => void applyLoadout(loadout)}
          busy={busy}
        />
      )}
    </div>
  );
}
