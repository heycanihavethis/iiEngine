import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  appLayoutOptions,
  encodeCustomIcon,
  exportAppearancePreset,
  gridPageRevealSpeedOptions,
  homeBackgroundOptions,
  importAppearancePreset,
  openingOptions,
  pageAmbientOptions,
  themeOptions,
  type AppLayoutId,
  type GridPageRevealSpeed,
  type HomeBackgroundId,
  type OpeningScene,
  type PageAmbientId,
  type ThemeId,
} from './appearance';
import { apiRequest, errorMessage } from './api';
import { EngineIcon } from './EngineIcon';
import { homeBackgroundImages } from './homeBackgrounds';
import { usePreferences } from './store';
import { trackFeature } from './telemetry';

export default function Customize({ coneKiller = false }: { coneKiller?: boolean }) {
  const prefs = usePreferences();
  const appearance = prefs.appearance;
  const [iconNotice, setIconNotice] = useState('');
  const [iconBusy, setIconBusy] = useState(false);
  const [presetNotice, setPresetNotice] = useState('');
  const [shareCode, setShareCode] = useState('');
  const [importCode, setImportCode] = useState('');
  const [presetBusy, setPresetBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const presetRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    trackFeature('customize', 'open');
  }, []);

  useEffect(() => {
    if (!coneKiller && appearance.homeBackgroundId === 'cat') {
      prefs.setAppearance({ homeBackgroundId: 'none' });
    }
  }, [coneKiller, appearance.homeBackgroundId, prefs]);

  async function applyCustomIcon(file: File) {
    setIconBusy(true);
    setIconNotice('');
    try {
      const encoded = await encodeCustomIcon(file);
      prefs.setAppearance({
        customIconDataUrl: encoded.previewDataUrl,
        customIconRgbaB64: encoded.rgbaB64,
        showConeMascot: false,
      });
      if (!isTauri()) {
        setIconNotice('Sidebar icon updated. Window/taskbar icon applies in the Windows app.');
        return;
      }
      await invoke('set_brand_icon', {
        rgbaB64: encoded.rgbaB64,
        width: encoded.width,
        height: encoded.height,
      });
      setIconNotice('Sidebar and window icon updated for this session.');
    } catch (reason) {
      setIconNotice(reason instanceof Error ? reason.message : 'Could not import icon.');
    } finally {
      setIconBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function clearCustomIcon() {
    prefs.setAppearance({
      customIconDataUrl: '',
      customIconRgbaB64: '',
      showConeMascot: true,
    });
    setIconNotice('Restored default cone icon.');
    if (isTauri()) {
      try {
        await invoke('set_brand_icon', { rgbaB64: null, width: null, height: null });
      } catch {}
    }
  }

  function exportPreset() {
    const preset = exportAppearancePreset(appearance);
    const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ii-engine-customize-v${preset.version}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setPresetNotice(`Exported Customize preset (v${preset.version}).`);
    trackFeature('customize', 'export_preset');
  }

  async function exportShareCode() {
    setPresetBusy(true);
    setPresetNotice('');
    const preset = exportAppearancePreset(appearance);
    try {
      const response = await apiRequest('/v1/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset }),
      });
      const payload = (await response.json()) as { code?: string; note?: string };
      if (!payload.code) throw new Error('No share code returned.');
      setShareCode(payload.code);
      try {
        await navigator.clipboard.writeText(payload.code);
        setPresetNotice(
          `Share code ${payload.code} copied. Others with Pro can import it.${
            payload.note ? ` ${payload.note}` : ''
          }`,
        );
      } catch {
        setPresetNotice(`Share code ready: ${payload.code}. Copy it to share with Pro users.`);
      }
      trackFeature('customize', 'export_share_code');
    } catch (reason) {
      try {
        const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(preset))))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/g, '');
        const localCode = `CUSLOCAL.${encoded}`;
        setShareCode(localCode.slice(0, 24) + '…');
        await navigator.clipboard.writeText(localCode);
        setPresetNotice(
          `Server share unavailable (${errorMessage(reason, 'error')}). ` +
            `A local share code was copied instead. Friends can paste it under Import share code.`,
        );
        trackFeature('customize', 'export_share_code_local');
      } catch {
        setPresetNotice(errorMessage(reason, 'Could not create a share code.'));
      }
    } finally {
      setPresetBusy(false);
    }
  }

  async function importShareCode() {
    const code = importCode.trim();
    if (!code) return;
    setPresetBusy(true);
    setPresetNotice('');
    try {
      if (/^CUSLOCAL\./i.test(code)) {
        const raw = code
          .slice(code.indexOf('.') + 1)
          .replace(/-/g, '+')
          .replace(/_/g, '/');
        const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
        const json = decodeURIComponent(escape(atob(padded)));
        const next = importAppearancePreset(JSON.parse(json));
        prefs.setAppearance(next);
        setImportCode('');
        setPresetNotice('Imported local share payload. Layout and theme applied.');
        trackFeature('customize', 'import_share_code_local');
        return;
      }
      const response = await apiRequest(`/v1/presets/${encodeURIComponent(code.toUpperCase())}`);
      const payload = (await response.json()) as { preset?: unknown };
      const next = importAppearancePreset(payload.preset);
      prefs.setAppearance(next);
      setImportCode('');
      setPresetNotice(`Imported preset from ${code.toUpperCase()}. Layout and theme applied.`);
      trackFeature('customize', 'import_share_code');
    } catch (reason) {
      setPresetNotice(errorMessage(reason, 'Could not import that share code.'));
    } finally {
      setPresetBusy(false);
    }
  }

  async function importPreset(file: File) {
    setPresetNotice('');
    try {
      const raw = JSON.parse(await file.text()) as unknown;
      const next = importAppearancePreset(raw);
      prefs.setAppearance(next);
      setPresetNotice('Imported Customize preset. Layout and theme applied.');
      trackFeature('customize', 'import_preset');
    } catch (reason) {
      setPresetNotice(reason instanceof Error ? reason.message : 'Could not import preset.');
    } finally {
      if (presetRef.current) presetRef.current.value = '';
    }
  }

  return (
    <div className="customize-page">
      <header className="page-header customize-hero" aria-label="Customize">
        <div className="page-header-main">
          <h1 className="page-header-title">Customize</h1>
          <p className="page-header-subtitle">Theme, branding, and Home layout. Pro only.</p>
        </div>
      </header>

      <div className="panel customize-preset-bar">
        <div className="customize-preset-actions">
          <button type="button" disabled={presetBusy} onClick={() => void exportShareCode()}>
            <EngineIcon name="copy" size={14} /> {shareCode ? `Code ${shareCode}` : 'Share code'}
          </button>
          <button type="button" onClick={exportPreset}>
            <EngineIcon name="download" size={14} /> Export
          </button>
          <button type="button" onClick={() => presetRef.current?.click()}>
            <EngineIcon name="upload" size={14} /> Import
          </button>
          <input
            ref={presetRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importPreset(file);
            }}
          />
          <button type="button" onClick={() => prefs.resetAppearance()}>
            Reset
          </button>
        </div>
        <div className="customize-preset-import">
          <input
            value={importCode}
            aria-label="Import share code"
            onChange={(event) => setImportCode(event.target.value.toUpperCase())}
            placeholder="CUS-XXXXXXXX"
            maxLength={16}
            spellCheck={false}
          />
          <button
            type="button"
            disabled={presetBusy || !importCode.trim()}
            onClick={() => void importShareCode()}
          >
            Import code
          </button>
        </div>
      </div>
      {presetNotice && (
        <p className="customize-note" role="status">
          {presetNotice}
        </p>
      )}

      <section className="panel customize-section">
        <header className="customize-section-head">
          <h3>
            <EngineIcon name="palette" size={14} /> Theme
          </h3>
          <p>Pick Gray or Warm. Both keep orange accents.</p>
        </header>
        <div className="theme-pair-grid" role="listbox" aria-label="App theme">
          {themeOptions.map((theme) => (
            <button
              key={theme.id}
              type="button"
              role="option"
              aria-selected={appearance.themeId === theme.id}
              className={`theme-pair theme-pair-${theme.id} ${appearance.themeId === theme.id ? 'active' : ''}`}
              onClick={() => prefs.setAppearance({ themeId: theme.id as ThemeId })}
            >
              <span className="theme-pair-preview" aria-hidden="true" />
              <strong>{theme.label}</strong>
              <small>{theme.blurb}</small>
            </button>
          ))}
        </div>
        <div className="customize-grid">
          <label>
            Density
            <select
              value={appearance.density}
              onChange={(event) =>
                prefs.setAppearance({
                  density: event.target.value as 'comfortable' | 'compact',
                })
              }
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </label>
          <label>
            Corners
            <select
              value={appearance.radius}
              onChange={(event) =>
                prefs.setAppearance({ radius: event.target.value as 'rounded' | 'sharp' })
              }
            >
              <option value="rounded">Rounded</option>
              <option value="sharp">Sharp</option>
            </select>
          </label>
        </div>
      </section>

      <section className="panel customize-section">
        <header className="customize-section-head">
          <h3>
            <EngineIcon name="type" size={14} /> Name and icon
          </h3>
          <p>Shows in the sidebar. On Windows it also changes the window icon.</p>
        </header>
        <div className="customize-grid">
          <label>
            App name
            <input
              maxLength={32}
              value={appearance.appName}
              onChange={(event) => prefs.setAppearance({ appName: event.target.value })}
            />
          </label>
          <label>
            Tagline
            <input
              maxLength={40}
              value={appearance.tagline}
              onChange={(event) => prefs.setAppearance({ tagline: event.target.value })}
            />
          </label>
        </div>
        <div className="custom-icon-import">
          <div className="custom-icon-preview" aria-hidden="true">
            {appearance.customIconDataUrl ? (
              <img src={appearance.customIconDataUrl} alt="" />
            ) : (
              <span className="custom-icon-fallback">ii</span>
            )}
          </div>
          <div className="custom-icon-actions">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void applyCustomIcon(file);
              }}
            />
            <button
              type="button"
              className="primary"
              disabled={iconBusy}
              onClick={() => fileRef.current?.click()}
            >
              <EngineIcon name="image" size={16} />
              {iconBusy ? 'Importing…' : 'Import image'}
            </button>
            {appearance.customIconDataUrl && (
              <button type="button" disabled={iconBusy} onClick={() => void clearCustomIcon()}>
                <EngineIcon name="trash" size={16} />
                Use default cone
              </button>
            )}
            <small>PNG, JPG, or WebP · square · under 4 MB</small>
          </div>
        </div>
        {iconNotice && (
          <p className="customize-note" role="status">
            {iconNotice}
          </p>
        )}
      </section>

      <section className="panel customize-section">
        <header className="customize-section-head">
          <h3>
            <EngineIcon name="layout" size={14} /> Layout
          </h3>
          <p>Sidebar width and workspace density. Navigation stays the same.</p>
        </header>
        <div className="layout-picker" role="listbox" aria-label="App layout">
          {appLayoutOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={appearance.appLayout === option.id}
              className={`layout-option ${appearance.appLayout === option.id ? 'active' : ''}`}
              onClick={() => prefs.setAppearance({ appLayout: option.id as AppLayoutId })}
            >
              <span
                className={`layout-option-preview layout-preview-${option.id}`}
                aria-hidden="true"
              />
              <strong>{option.label}</strong>
              <small>{option.blurb}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="panel customize-section">
        <header className="customize-section-head">
          <h3>
            <EngineIcon name="image" size={14} /> Home background
          </h3>
          <p>Full-screen photo behind Home. The launch card stays solid.</p>
        </header>
        <div className="home-bg-picker" role="listbox" aria-label="Home background">
          {homeBackgroundOptions.map((option) => {
            const locked = option.id === 'cat' && !coneKiller;
            const preview =
              option.id === 'none'
                ? null
                : homeBackgroundImages[option.id as Exclude<HomeBackgroundId, 'none'>];
            return (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={appearance.homeBackgroundId === option.id}
                aria-disabled={locked}
                disabled={locked}
                className={`home-bg-option ${appearance.homeBackgroundId === option.id ? 'active' : ''} ${locked ? 'locked' : ''}`}
                onClick={() => {
                  if (locked) return;
                  prefs.setAppearance({ homeBackgroundId: option.id });
                }}
              >
                <span
                  className="home-bg-option-preview"
                  style={preview ? { backgroundImage: `url(${preview})` } : undefined}
                  aria-hidden="true"
                />
                <strong>{option.label}</strong>
                <small>{locked ? 'Requires “I killed the cone” role.' : option.blurb}</small>
              </button>
            );
          })}
        </div>
        {appearance.homeBackgroundId !== 'none' && (
          <div className="customize-grid">
            <label className="customize-check">
              <input
                type="checkbox"
                checked={appearance.homeBackgroundBlur}
                onChange={(event) =>
                  prefs.setAppearance({ homeBackgroundBlur: event.target.checked })
                }
              />
              Soft blur
            </label>
            <label>
              Blur amount
              <input
                type="range"
                min={4}
                max={40}
                step={1}
                disabled={!appearance.homeBackgroundBlur}
                value={appearance.homeBackgroundBlurIntensity}
                onChange={(event) =>
                  prefs.setAppearance({
                    homeBackgroundBlurIntensity: Number(event.target.value) || 12,
                  })
                }
              />
              <small>{appearance.homeBackgroundBlurIntensity}px</small>
            </label>
          </div>
        )}
      </section>

      <section className="panel customize-section">
        <header className="customize-section-head">
          <h3>
            <EngineIcon name="sparkles" size={14} /> Startup
          </h3>
          <p>Opening scene when the app launches.</p>
        </header>
        <div className="customize-grid">
          <label>
            Opening scene
            <select
              value={appearance.openingScene}
              onChange={(event) =>
                prefs.setAppearance({ openingScene: event.target.value as OpeningScene })
              }
            >
              {openingOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Intro length (ms)
            <input
              type="number"
              min={600}
              max={4000}
              step={50}
              value={appearance.introDurationMs}
              onChange={(event) =>
                prefs.setAppearance({ introDurationMs: Number(event.target.value) || 900 })
              }
            />
          </label>
        </div>
      </section>

      <section className="panel customize-section">
        <header className="customize-section-head">
          <h3>
            <EngineIcon name="sparkles" size={14} /> Motion
          </h3>
          <p>Page switches and background patterns. Honors Reduce motion in Settings.</p>
        </header>
        <label className="customize-check">
          <input
            type="checkbox"
            checked={appearance.gridPageReveal}
            onChange={(event) => prefs.setAppearance({ gridPageReveal: event.target.checked })}
          />
          <span>
            <strong>Grid page switcher</strong>
            <small>Squares slide over the screen, then open on the next page.</small>
          </span>
        </label>
        {appearance.gridPageReveal && (
          <div className="customize-ambient" role="radiogroup" aria-label="Grid switcher speed">
            <div className="customize-ambient-copy">
              <strong>Switcher speed</strong>
              <small>How fast the cover and reveal run.</small>
            </div>
            <div className="customize-ambient-options">
              {gridPageRevealSpeedOptions.map((option) => (
                <label
                  key={option.id}
                  className={`customize-ambient-option ${
                    appearance.gridPageRevealSpeed === option.id ? 'active' : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="customize-grid-speed"
                    value={option.id}
                    checked={appearance.gridPageRevealSpeed === option.id}
                    onChange={() =>
                      prefs.setAppearance({
                        gridPageRevealSpeed: option.id as GridPageRevealSpeed,
                      })
                    }
                  />
                  <strong>{option.label}</strong>
                  <small>{option.blurb}</small>
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="customize-ambient" role="radiogroup" aria-label="Background pattern">
          <div className="customize-ambient-copy">
            <strong>Background pattern</strong>
            <small>Light pattern behind pages. Gets brighter near your cursor.</small>
          </div>
          <div className="customize-ambient-options">
            {pageAmbientOptions.map((option) => (
              <label
                key={option.id}
                className={`customize-ambient-option ${
                  appearance.pageAmbient === option.id ? 'active' : ''
                }`}
              >
                <input
                  type="radio"
                  name="customize-page-ambient"
                  value={option.id}
                  checked={appearance.pageAmbient === option.id}
                  onChange={() => prefs.setAppearance({ pageAmbient: option.id as PageAmbientId })}
                />
                <strong>{option.label}</strong>
                <small>{option.blurb}</small>
              </label>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
