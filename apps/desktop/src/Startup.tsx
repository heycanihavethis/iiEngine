import { useEffect, useState, type MouseEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Dashboard } from '../../../packages/contracts/dashboard';
import cone from '../../../packages/brand/cone.svg';
import coneEmber from '../../../packages/brand/cone-ember.svg';
import type { AppAppearance } from './appearance';
import { appearanceClassNames, appearanceStyle, defaultAppearance } from './appearance';
import { isSessionExpiredError } from './api';

export function Startup({
  data,
  pending,
  error,
  loggingIn,
  notice,
  appearance = defaultAppearance,
  onLogin,
  onContinue,
  onDemo,
  onRetry,
}: {
  data?: Dashboard;
  pending: boolean;
  error: Error | null;
  loggingIn: boolean;
  notice: string;
  appearance?: AppAppearance;
  onLogin: () => void;
  onContinue: () => void;
  onDemo: () => void;
  onRetry: () => void;
}) {
  const testMode = import.meta.env.MODE === 'test';
  const [intro, setIntro] = useState(!testMode);
  const windowAction = (action: string) => {
    if (isTauri()) void invoke(action);
  };
  const drag = (event: MouseEvent<HTMLElement>) => {
    if (!isTauri() || event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    void invoke('start_dragging_window');
  };
  useEffect(() => {
    if (testMode) return;
    const timer = window.setTimeout(() => setIntro(false), appearance.introDurationMs);
    return () => window.clearTimeout(timer);
  }, [testMode, appearance.introDurationMs]);
  const title = appearance.appName;
  const coneSrc = appearance.themeId === 'ember' ? coneEmber : cone;
  const showCone = appearance.showConeMascot && appearance.openingScene !== 'minimal';
  const fade = { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <div
      className={`startup-shell ${appearanceClassNames(appearance)} scene-${appearance.openingScene}`}
      style={appearanceStyle(appearance)}
      data-tauri-drag-region
      onMouseDown={drag}
      onDoubleClick={(event) => {
        if (!(event.target as HTMLElement).closest('button'))
          windowAction('toggle_maximize_window');
      }}
    >
      <div className="startup-grid" aria-hidden="true" />
      {isTauri() && (
        <div className="startup-windowbar" data-tauri-drag-region="false">
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
      <AnimatePresence mode="wait">
        {intro ? (
          <motion.div
            className="startup-intro"
            key="intro"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={fade}
          >
            {showCone ? (
              <img className="startup-scene-art" src={coneSrc} alt="" />
            ) : (
              <span className="startup-minimal-mark" />
            )}
            <h1>{title}</h1>
            <p className="startup-intro-tag">{appearance.tagline}</p>
          </motion.div>
        ) : (
          <motion.section
            className="startup-card"
            key="account"
            initial={testMode ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={fade}
          >
            {appearance.showConeMascot ? (
              <img className="startup-mark" src={coneSrc} alt={appearance.appName} />
            ) : (
              <span className="startup-minimal-mark card" />
            )}
            <span className="eyebrow">{title}</span>
            {pending ? (
              <div className="startup-loading" role="status">
                <RefreshCw /> Restoring your session…
              </div>
            ) : data && !data.demo ? (
              <>
                <h1>Welcome back</h1>
                <p>Continue with your saved Discord account.</p>
                <button className="account-choice primary" onClick={onContinue}>
                  {data.member.avatar ? (
                    <img src={data.member.avatar} alt="" />
                  ) : (
                    <span className="avatar-fallback">{data.member.display_name[0]}</span>
                  )}
                  <span>
                    <strong>{data.member.display_name}</strong>
                    <small>Discord account</small>
                  </span>
                  <ArrowRight />
                </button>
                <button className="text-button" onClick={onLogin}>
                  Use another Discord account
                </button>
              </>
            ) : data?.demo ? (
              <>
                <h1>Ready to launch</h1>
                <p>Check your install, get updates, and play Gorilla Tag.</p>
                <button className="primary" onClick={onDemo}>
                  Continue <ArrowRight size={18} />
                </button>
              </>
            ) : (
              <>
                {error && isSessionExpiredError(error) ? (
                  <>
                    <h1>Sign in to continue</h1>
                    <p>
                      Your Discord login needs a quick refresh. Sign in again. You do not need to
                      reinstall.
                    </p>
                    <button
                      className="primary discord-login"
                      disabled={loggingIn}
                      onClick={onLogin}
                    >
                      {loggingIn ? 'Waiting for Discord…' : 'Sign in with Discord'}{' '}
                      <ArrowRight size={18} />
                    </button>
                  </>
                ) : error ? (
                  <div role="alert" className="startup-connection-error">
                    <h1>Can&apos;t connect right now</h1>
                    <p>
                      ii Engine couldn&apos;t reach the network. Check your connection and try
                      again.
                    </p>
                    {error.message.trim() && <p className="startup-error">{error.message}</p>}
                    <button className="primary" onClick={onRetry}>
                      Try again
                    </button>
                    <button className="text-button" disabled={loggingIn} onClick={onLogin}>
                      {loggingIn ? 'Waiting for Discord…' : 'Sign in with Discord instead'}
                    </button>
                  </div>
                ) : (
                  <>
                    <h1>Sign in to continue</h1>
                    <p>Use Discord to verify your server roles and open {appearance.appName}.</p>
                    <button
                      className="primary discord-login"
                      disabled={loggingIn}
                      onClick={onLogin}
                    >
                      {loggingIn ? 'Waiting for Discord…' : 'Sign in with Discord'}{' '}
                      <ArrowRight size={18} />
                    </button>
                  </>
                )}
              </>
            )}
            {notice && (
              <p role="status" className="startup-notice">
                {notice}
              </p>
            )}
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}
