import { apiRequest } from './api';
import { usePreferences } from './store';

const SESSION_KEY = 'ii-engine-session-journal-v1';
const MAX_CHARS = 450_000;
const ERROR_LINE = /(error|exception|fatal|fail(?:ed|ure)?|crash|stack\s*trace)/i;
const USER_PROFILE_PATH =
  /([A-Za-z]:[\\/]+Users[\\/]+|[\\/](?:home|Users)[\\/]+)([^\\/\s"'<>|*?]+)/g;

type SessionEntry = {
  at: string;
  kind: string;
  detail: string;
};

type SessionJournal = {
  startedAt: string;
  appVersion: string;
  platform: string;
  entries: SessionEntry[];
  bepinex: string;
  flushed: boolean;
};

let journal: SessionJournal | null = null;
let flushInFlight: Promise<void> | null = null;
let hourlyTimer: number | null = null;
let lastHourlySentAt = 0;

function telemetryMeta(current?: SessionJournal | null) {
  return {
    app_version: current?.appVersion || '0.2.2',
    platform: current?.platform || navigator.platform || 'unknown',
  };
}

export function telemetryEnabled() {
  return usePreferences.getState().telemetry !== false;
}

export function redactUserPaths(text: string) {
  return text.replace(USER_PROFILE_PATH, (match, prefix: string, name: string) =>
    name === 'Public' || name === 'Default' ? match : `${prefix}<user>`,
  );
}

function nowIso() {
  return new Date().toISOString();
}

function persist() {
  if (!journal) return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(journal));
  } catch {}
}

function ensureJournal(): SessionJournal {
  if (journal) return journal;
  journal = {
    startedAt: nowIso(),
    appVersion: '0.2.2',
    platform: navigator.platform || 'unknown',
    entries: [],
    bepinex: '',
    flushed: false,
  };
  persist();
  return journal;
}

function adoptStoredJournal(raw: unknown): SessionJournal | null {
  if (!raw || typeof raw !== 'object') return null;
  const stored = raw as Partial<SessionJournal>;
  if (!stored.startedAt) return null;
  const entries = Array.isArray(stored.entries) ? stored.entries : [];
  return {
    startedAt: String(stored.startedAt),
    appVersion: String(stored.appVersion || '0.2.2').slice(0, 40),
    platform: String(stored.platform || 'unknown').slice(0, 40),
    entries: entries
      .filter((entry): entry is SessionEntry => Boolean(entry && typeof entry === 'object'))
      .map((entry) => ({
        at: String(entry.at || ''),
        kind: String(entry.kind || '').slice(0, 40),
        detail: String(entry.detail || ''),
      })),
    bepinex: String(stored.bepinex || ''),
    flushed: Boolean(stored.flushed),
  };
}

function trimJournal(current: SessionJournal) {
  let encoded = JSON.stringify(current);
  if (encoded.length <= MAX_CHARS) return;
  while (current.entries.length > 20 && encoded.length > MAX_CHARS) {
    current.entries.shift();
    encoded = JSON.stringify(current);
  }
  if (encoded.length > MAX_CHARS && current.bepinex.length > 80_000) {
    current.bepinex = current.bepinex.slice(-80_000);
  }
}

function featureCounts(current: SessionJournal) {
  const counts: Record<string, number> = {};
  for (const entry of current.entries) {
    const key = entry.kind.replace(/^ai:/, 'ai_').slice(0, 40);
    if (!key || key === 'game_path') continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function extractBepinexErrors(bepinex: string) {
  if (!bepinex.trim()) return '';
  const lines = bepinex.split(/\r?\n/);
  const hits: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!ERROR_LINE.test(lines[index] || '')) continue;
    const chunk = lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 3)).join('\n');
    if (chunk.trim() && !hits.includes(chunk.trim())) hits.push(chunk.trim());
    if (hits.length >= 80) break;
  }
  return hits.join('\n\n---\n\n').slice(0, 180_000);
}

export function beginSession() {
  if (!telemetryEnabled()) return;
  const raw = localStorage.getItem(SESSION_KEY);
  ensureJournal();
  startHourlyPulse();
  try {
    if (!raw) return;
    const previous = adoptStoredJournal(JSON.parse(raw));
    if (
      previous &&
      !previous.flushed &&
      previous.startedAt !== journal?.startedAt &&
      (previous.entries.length || previous.bepinex)
    ) {
      void uploadJournal(previous, 'orphan-recovery');
    }
  } catch {}
}

export function trackFeature(feature: string, detail = '') {
  if (!telemetryEnabled()) return;
  const current = ensureJournal();
  current.entries.push({
    at: nowIso(),
    kind: feature.slice(0, 40),
    detail: detail.slice(0, 12_000),
  });
  trimJournal(current);
  persist();
}

export function reportEngineError(options: { feature?: string; message: string; detail?: string }) {
  const message = options.message.trim();
  if (!message) return;
  trackFeature(options.feature || 'engine_error', message.slice(0, 2000));
}

export function appendSessionBepInEx(chunk: string, gamePath = '') {
  if (!telemetryEnabled() || !chunk) return;
  const current = ensureJournal();
  if (gamePath && !current.entries.some((entry) => entry.kind === 'game_path')) {
    current.entries.push({ at: nowIso(), kind: 'game_path', detail: gamePath.slice(0, 400) });
  }
  current.bepinex = (current.bepinex + chunk).slice(-350_000);
  if (ERROR_LINE.test(chunk)) {
    const snippet = chunk
      .split(/\r?\n/)
      .filter((line) => ERROR_LINE.test(line))
      .slice(0, 4)
      .join(' | ')
      .slice(0, 500);
    if (snippet) {
      current.entries.push({ at: nowIso(), kind: 'bepinex_error', detail: snippet });
    }
  }
  trimJournal(current);
  persist();
}

export function recordAiTranscript(source: string, prompt: string, response: string) {
  if (!telemetryEnabled()) return;
  const current = ensureJournal();
  current.entries.push({
    at: nowIso(),
    kind: `ai:${source}`.slice(0, 40),
    detail: `PROMPT:\n${prompt.slice(0, 6000)}\n\nRESPONSE:\n${response.slice(0, 12_000)}`,
  });
  trimJournal(current);
  persist();
}

function renderJournal(current: SessionJournal, reason: string) {
  const errors = extractBepinexErrors(current.bepinex);
  const lines = [
    `ii Engine session journal`,
    `reason: ${reason}`,
    `started: ${current.startedAt}`,
    `ended: ${nowIso()}`,
    `app: ${current.appVersion}`,
    `platform: ${current.platform}`,
    '',
    '=== ACTIONS / AI ===',
  ];
  for (const entry of current.entries) {
    lines.push(`[${entry.at}] ${entry.kind}`);
    if (entry.detail) lines.push(entry.detail);
    lines.push('');
  }
  if (errors) {
    lines.push('=== BEPINEX ERRORS ===');
    lines.push(errors);
    lines.push('');
  }
  if (current.bepinex.trim()) {
    lines.push('=== BEPINEX LOGOUTPUT ===');
    lines.push(current.bepinex.trim());
  }
  return {
    text: redactUserPaths(lines.join('\n')).slice(0, 500_000),
    errors: redactUserPaths(errors),
  };
}

async function uploadJournal(current: SessionJournal, reason: string) {
  if (!telemetryEnabled()) return;
  const { text, errors } = renderJournal(current, reason);
  if (text.length < 40) return;
  const gamePath = current.entries.find((entry) => entry.kind === 'game_path')?.detail ?? '';
  await apiRequest('/v1/telemetry/session-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'launch',
      log_text: text,
      game_path: redactUserPaths(gamePath).slice(0, 400),
      features: featureCounts(current),
      bepinex_errors: errors,
      ...telemetryMeta(current),
    }),
  });
}

export async function flushSessionLog(reason = 'session-end') {
  if (!telemetryEnabled()) return;
  if (flushInFlight) return flushInFlight;
  const current = ensureJournal();
  if (current.flushed) return;
  if (!current.entries.length && current.bepinex.trim().length < 40) {
    current.flushed = true;
    persist();
    return;
  }
  flushInFlight = (async () => {
    try {
      await uploadJournal(current, reason);
      current.flushed = true;
      persist();
      try {
        localStorage.removeItem(SESSION_KEY);
      } catch {}
    } catch {
    } finally {
      flushInFlight = null;
    }
  })();
  return flushInFlight;
}

async function sendHourlyPulse() {
  if (!telemetryEnabled()) return;
  const now = Date.now();
  if (now - lastHourlySentAt < 50 * 60_000) return;
  const current = ensureJournal();
  try {
    await apiRequest('/v1/telemetry/hourly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        features: featureCounts(current),
        ...telemetryMeta(current),
      }),
    });
    lastHourlySentAt = now;
  } catch {}
}

export function startHourlyPulse() {
  if (!telemetryEnabled() || hourlyTimer != null) return;
  window.setTimeout(() => void sendHourlyPulse(), 120_000);
  hourlyTimer = window.setInterval(() => void sendHourlyPulse(), 60 * 60_000);
}

export function stopHourlyPulse() {
  if (hourlyTimer != null) {
    window.clearInterval(hourlyTimer);
    hourlyTimer = null;
  }
}

export async function reportSessionLog(options: {
  kind?: 'launch' | 'studio';
  logText: string;
  gamePath?: string;
}) {
  if (options.logText) appendSessionBepInEx(options.logText, options.gamePath);
}
