import type { Page } from './store';

export type TrackerNavIntent = {
  page: Extract<Page, 'Tracker' | 'Target Tracker'>;
  playerId?: string;
  room?: string;
  section?: 'players' | 'cosmetics' | 'assist' | 'rares';
  watch?: boolean;
  query?: string;
};

const INTENT_KEY = 'ii.tracker.navIntent.v1';

export function setTrackerNavIntent(intent: TrackerNavIntent) {
  try {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify(intent));
  } catch {}
}

export function consumeTrackerNavIntent(): TrackerNavIntent | null {
  try {
    const raw = sessionStorage.getItem(INTENT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(INTENT_KEY);
    const parsed = JSON.parse(raw) as TrackerNavIntent;
    if (!parsed || (parsed.page !== 'Tracker' && parsed.page !== 'Target Tracker')) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export type TrackerAssistAction =
  | { kind: 'target'; playerId: string; label: string }
  | { kind: 'player'; playerId: string; label: string }
  | { kind: 'room'; room: string; label: string }
  | { kind: 'section'; section: 'players' | 'cosmetics' | 'assist' | 'rares'; label: string };

const ACTION_RE = /\[\[(target|player|room|section):([A-Za-z0-9_-]{2,40})(?:\|([^\]]{1,48}))?\]\]/g;

const SECTION_LABELS: Record<'players' | 'cosmetics' | 'assist' | 'rares', string> = {
  players: 'Jump to players',
  cosmetics: 'Special cosmetics',
  assist: 'Ask Assist again',
  rares: 'Recent rares',
};

export function parseAssistActions(answer: string): {
  text: string;
  actions: TrackerAssistAction[];
} {
  const actions: TrackerAssistAction[] = [];
  const seen = new Set<string>();
  for (const match of answer.matchAll(ACTION_RE)) {
    const [, kind, value, customLabel] = match;
    const key = `${kind}:${value.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (kind === 'target' || kind === 'player') {
      const playerId = value.toUpperCase();
      actions.push({
        kind,
        playerId,
        label:
          customLabel?.trim() ||
          (kind === 'target' ? `Watch ${playerId.slice(0, 8)}…` : `Find ${playerId.slice(0, 8)}…`),
      });
    } else if (kind === 'room') {
      const room = value.toUpperCase();
      actions.push({
        kind: 'room',
        room,
        label: customLabel?.trim() || `Open room ${room}`,
      });
    } else if (kind === 'section') {
      const section = value.toLowerCase();
      if (
        section === 'players' ||
        section === 'cosmetics' ||
        section === 'assist' ||
        section === 'rares'
      ) {
        actions.push({
          kind: 'section',
          section,
          label: customLabel?.trim() || SECTION_LABELS[section] || section,
        });
      }
    }
  }
  const text = answer
    .replace(ACTION_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, actions: actions.slice(0, 6) };
}
