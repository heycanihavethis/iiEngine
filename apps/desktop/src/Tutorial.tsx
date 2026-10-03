import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { errorMessage } from './api';
import { applyMenuUpdate, getMenuReleases, selectedRelease } from './launcher';
import type { Page } from './store';

export type TourStep = {
  id: string;
  title: string;
  text: string;
  page: Page;
  target?: string;
  setup?: boolean;
};

export function buildTourSteps(opts: {
  canHealth: boolean;
  canModLibrary: boolean;
  canCommunityChat: boolean;
  canStudio: boolean;
}): TourStep[] {
  const steps: TourStep[] = [
    {
      id: 'welcome',
      title: 'Welcome to ii Engine',
      text: 'This quick tour shows the places you’ll use most. We’ll collapse the sidebar and hide extra chrome so you can focus.',
      page: 'Home',
      target: '[data-tour="home-launch"]',
    },
    {
      id: 'launch',
      title: 'Launch from Home',
      text: 'Use Launch with ii Menu to play. Launch does not auto-update the menu — when an update is available, click Update ii Menu. The arrow menu has Play without ii, Play with current setup, and Verify File Integrity.',
      page: 'Home',
      target: '[data-tour="home-launch"]',
    },
  ];
  if (opts.canHealth) {
    steps.push({
      id: 'health',
      title: 'Health & Repair',
      text: 'When something’s wrong with Gorilla Tag or BepInEx, Health & Repair explains the issue before changing any files.',
      page: 'Health & Repair',
      target: '[data-tour="nav-health"]',
    });
  }
  if (opts.canModLibrary) {
    steps.push({
      id: 'mods',
      title: 'Mod Library',
      text: 'Install approved mods, import local DLLs, and enable or disable what you run with the menu.',
      page: 'Autoloader',
      target: '[data-tour="nav-mods"]',
    });
  }
  if (opts.canCommunityChat) {
    steps.push({
      id: 'community',
      title: 'Community',
      text: 'Announcements, chat, bugs, and ideas live here, including Engine announcements from the team.',
      page: 'Community',
      target: '[data-tour="nav-community"]',
    });
  }
  steps.push({
    id: 'tracker',
    title: 'Tracker',
    text: 'Player Tracker watches public lobbies for rare fits. Self Tracker is for Engine players sharing nick + room.',
    page: 'Tracker',
    target: '[data-tour="nav-tracker"]',
  });
  if (opts.canStudio) {
    steps.push({
      id: 'studio',
      title: 'ii Studio',
      text: 'Create a separate local C# project, build it, and use Build & Play. Studio never edits the master menu source.',
      page: 'ii Studio',
      target: '[data-tour="nav-studio"]',
    });
  }
  steps.push({
    id: 'ready',
    title: 'You’re ready',
    text: 'Optional: Install BepInEx + ii finds and installs the latest verified menu after you click the button (same path as Home → Update ii Menu). Launch later will keep using a menu that is already installed.',
    page: 'Home',
    target: '[data-tour="home-launch"]',
    setup: true,
  });
  return steps;
}

type Spot = { top: number; left: number; width: number; height: number };

function clampCardLeft(preferred: number, cardWidth: number) {
  const sidebar = document.querySelector('.sidebar');
  const sidebarRight =
    sidebar instanceof HTMLElement ? sidebar.getBoundingClientRect().right + 12 : 88;
  const maxLeft = Math.max(sidebarRight, window.innerWidth - cardWidth - 16);
  return Math.min(Math.max(preferred, sidebarRight), maxLeft);
}

export default function FirstRunTutorial({
  finish,
  demo,
  steps,
  navigate,
  onTourActive,
}: {
  finish: () => void;
  demo: boolean;
  steps: TourStep[];
  navigate: (page: Page) => void;
  onTourActive: (active: boolean) => void;
}) {
  const [step, setStep] = useState(0);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupStatus, setSetupStatus] = useState('');
  const [spot, setSpot] = useState<Spot | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const current = steps[step] ?? steps[0];

  useEffect(() => {
    onTourActive(true);
    return () => onTourActive(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (current?.page) navigate(current.page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, current?.page]);

  useLayoutEffect(() => {
    const measure = () => {
      const el = current?.target ? document.querySelector(current.target) : null;
      if (!(el instanceof HTMLElement)) {
        setSpot(null);
        return;
      }
      const rect = el.getBoundingClientRect();
      const pad = 10;
      setSpot({
        top: Math.max(8, rect.top - pad),
        left: Math.max(8, rect.left - pad),
        width: Math.min(window.innerWidth - 16, rect.width + pad * 2),
        height: Math.min(window.innerHeight - 16, rect.height + pad * 2),
      });
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    };
    measure();
    const timers = [120, 280, 450].map((ms) => window.setTimeout(measure, ms));
    window.addEventListener('resize', measure);
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      window.removeEventListener('resize', measure);
    };
  }, [step, current?.target, current?.page]);

  if (!current) return null;

  const isLast = step === steps.length - 1;
  const cardStyle = (() => {
    if (!spot) return undefined;
    const cardWidth = Math.min(400, window.innerWidth - 32);
    const preferBelow = spot.top + spot.height + 220 < window.innerHeight;
    const top = preferBelow
      ? Math.min(window.innerHeight - 220, spot.top + spot.height + 14)
      : Math.max(12, spot.top - 210);
    const left = clampCardLeft(spot.left, cardWidth);
    return { top, left } as const;
  })();

  const overlay = (
    <div className="tutorial-tour" aria-live="polite">
      <div className="tutorial-scrim" aria-hidden="true" />
      {spot && (
        <div
          className="tutorial-spotlight"
          style={{
            top: spot.top,
            left: spot.left,
            width: spot.width,
            height: spot.height,
          }}
          aria-hidden="true"
        />
      )}
      <section
        ref={cardRef}
        className={`tutorial-card tutorial-card-tour ${spot ? 'anchored' : 'centered'}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tutorial-title"
        style={spot && cardStyle ? { top: cardStyle.top, left: cardStyle.left } : undefined}
      >
        <span className="eyebrow">
          TOUR · {step + 1} OF {steps.length}
        </span>
        <h2 id="tutorial-title">{current.title}</h2>
        <p>{current.text}</p>
        {current.setup && (
          <div className="tutorial-setup">
            <button
              className="primary"
              type="button"
              disabled={setupBusy || demo || !isTauri()}
              onClick={() => {
                setSetupBusy(true);
                setSetupStatus('Finding the latest verified menu…');
                void getMenuReleases()
                  .then((catalog) =>
                    applyMenuUpdate(selectedRelease(catalog, null), setSetupStatus),
                  )
                  .then((result) =>
                    setSetupStatus(
                      result.unverified
                        ? "Couldn't verify installation. Using the ii menu already on this PC."
                        : 'Setup complete. Gorilla Tag is ready. Launch will not auto-update later — use Update ii Menu when a new version is available.',
                    ),
                  )
                  .catch((error) =>
                    setSetupStatus(errorMessage(error, 'Install BepInEx + ii could not finish.')),
                  )
                  .finally(() => setSetupBusy(false));
              }}
            >
              {setupBusy ? 'Installing…' : 'Install BepInEx + ii'}
            </button>
            {setupStatus && <small role="status">{setupStatus}</small>}
            {(demo || !isTauri()) && (
              <small>Install BepInEx + ii runs in the desktop app after you install Engine.</small>
            )}
          </div>
        )}
        <div className="tutorial-progress" aria-hidden="true">
          {steps.map((item, index) => (
            <span className={index <= step ? 'active' : ''} key={item.id} />
          ))}
        </div>
        <div className="tutorial-actions">
          <button className="text-button" type="button" onClick={finish}>
            Skip tutorial
          </button>
          {step > 0 && (
            <button type="button" onClick={() => setStep((value) => value - 1)}>
              Back
            </button>
          )}
          <button
            className="primary"
            type="button"
            onClick={() => (isLast ? finish() : setStep((value) => value + 1))}
          >
            {isLast ? 'Open ii Engine' : 'Next'} <ArrowRight size={16} />
          </button>
        </div>
      </section>
    </div>
  );

  return createPortal(overlay, document.body);
}
