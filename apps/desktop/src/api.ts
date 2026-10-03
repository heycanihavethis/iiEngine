import type { Dashboard } from '../../../packages/contracts/dashboard';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { clearMenuBridge } from './menuBridge';
import { clearMembershipCache } from './membershipCache';

let accessToken: string | null = null;
let accessTokenExpiresAt = 0;
let refreshPromise: Promise<void> | null = null;
let sessionInitialized = false;

export class ApiError extends Error {
  path?: string;
  rawDetail?: string;

  constructor(
    message: string,
    public status: number,
    opts?: { path?: string; rawDetail?: string },
  ) {
    super(message);
    this.path = opts?.path;
    this.rawDetail = opts?.rawDetail;
  }
}

export function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

export function adminErrorDetail(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const parts: string[] = [];
  if (error.status) {
    parts.push(`HTTP ${error.status}`);
  } else if (
    error.rawDetail === 'timeout' ||
    /timed out|timeout/i.test(error.message) ||
    /timeout/i.test(error.rawDetail || '')
  ) {
    parts.push('timeout');
  } else {
    parts.push('network');
  }
  if (error.path) parts.push(error.path);
  const raw = error.rawDetail?.trim() || '';
  if (
    raw &&
    raw !== error.message.trim() &&
    raw !== 'timeout' &&
    raw !== 'fetch failed' &&
    !/^failed to fetch$/i.test(raw)
  ) {
    parts.push(raw);
  } else if (raw && !error.status && parts[0] === 'network' && !/^failed to fetch$/i.test(raw)) {
    parts.push(raw);
  }
  return parts.join(' · ');
}

function requestTimeoutSignal(ms: number, existing?: AbortSignal | null | undefined): AbortSignal {
  if (existing) return existing;
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
  } catch {}
  const controller = new AbortController();
  window.setTimeout(() => controller.abort(new DOMException('TimeoutError', 'TimeoutError')), ms);
  return controller.signal;
}

function fetchFailureApiError(error: unknown, path: string): ApiError {
  const name =
    error instanceof DOMException ? error.name : error instanceof Error ? error.name : '';
  const msg = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const timedOut =
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    /timeout|timed out|aborted/i.test(msg) ||
    /timeout|timed out|aborted/i.test(name);
  const tracker = /\/v1\/tracker\//i.test(path);
  const billing = /\/v1\/billing\//i.test(path);
  if (timedOut) {
    return new ApiError(
      tracker
        ? 'Live tracker took too long to answer. Hit Refresh in a moment.'
        : billing
          ? 'Roblox ownership check took too long. Wait a few seconds and try Claim again.'
          : 'The Engine API timed out. Try again in a moment.',
      0,
      { path, rawDetail: 'timeout' },
    );
  }
  return new ApiError(
    tracker
      ? "Couldn't reach the live tracker API. If the rest of Engine still works, the tracker backend may be down — try Refresh."
      : billing
        ? "Couldn't reach the Engine billing API. If Discord login still works, try Claim again in a moment."
        : "ii Engine can't reach the network right now. Check your connection and try again.",
    0,
    { path, rawDetail: msg.trim() || 'fetch failed' },
  );
}

function defaultHttpErrorMessage(status: number, path: string): string {
  if (status === 401) return 'Sign in to continue.';
  if (status === 403) {
    if (/\/v1\/tracker\//i.test(path)) {
      return 'Live tracker needs the beta tracker role (or staff).';
    }
    return "You don't have access to this.";
  }
  if (status === 404) {
    return (
      `Engine could not find ${path}. The API may be on an older build. ` +
      'Update ii Engine or wait for the backend to redeploy, then try again.'
    );
  }
  if (status === 429) return 'Too many requests. Wait a few seconds and try again.';
  if (status >= 500) return 'The Engine API hit a server error. Try again in a moment.';
  return `Request failed (${status}).`;
}

export function isSessionExpiredError(error: unknown): boolean {
  if (error instanceof ApiError && error.status === 401) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /discord session expired|sign in again|sign in to continue|could not authorize/i.test(
    message,
  );
}

export function friendlyApiDetail(detail: string, path: string, status: number): string {
  const trimmed = detail.trim();
  if (
    status === 503 &&
    /discord membership is temporarily unavailable|discord is temporarily unavailable/i.test(
      trimmed,
    )
  ) {
    return (
      'Discord is briefly unreachable. Engine is using your last verified membership. ' +
      'Try again in a moment if something still looks locked.'
    );
  }
  if (status === 403 && /\/v1\/tracker\//i.test(path)) {
    if (/beta|live tracker/i.test(trimmed)) {
      return 'Live tracker needs the beta tracker role (or staff).';
    }
    if (/unlock|ii tracker/i.test(trimmed)) {
      return 'ii Tracker unlock required. Grab it on Plans, or ask staff for the role.';
    }
  }
  if (status === 404 && /^not found$/i.test(trimmed)) {
    if (/\/v1\/tracker\//i.test(path)) {
      return (
        'Tracker API route missing on this backend. Redeploy the Engine API that includes ' +
        '/v1/tracker/session and /v1/tracker/feed, then try again.'
      );
    }
    return (
      `Engine could not find ${path}. The API may be on an older build. ` +
      `Update ii Engine or wait for the backend to redeploy, then try again.`
    );
  }
  if (
    /cannot authorize|authorization failed|invalid_grant|access_denied|refresh replay|invalid refresh/i.test(
      trimmed,
    )
  ) {
    return (
      'Your Discord login needs to be renewed. Sign in with Discord again. ' +
      'You should not need to refresh or reinstall the app.'
    );
  }
  return trimmed || detail;
}

const configuredOrigin =
  import.meta.env.VITE_BACKEND_PUBLIC_URL?.replace(/\/$/, '') ||
  (import.meta.env.PROD ? 'https://ii-engine-api-production.up.railway.app' : '');

function endpoint(path: string) {
  if (configuredOrigin) {
    const url = new URL(configuredOrigin);
    if (
      url.protocol !== 'https:' &&
      !(import.meta.env.DEV && ['127.0.0.1', 'localhost'].includes(url.hostname))
    )
      throw new Error('This connection must use a secure link.');
  }
  return `${configuredOrigin || (isTauri() ? 'http://127.0.0.1:8000' : '')}${path}`;
}

function noteAccessToken(token: string | null, expiresInSec = 900) {
  accessToken = token;
  accessTokenExpiresAt = token ? Date.now() + Math.max(60, expiresInSec - 90) * 1000 : 0;
}

export function hasAccessToken() {
  return Boolean(accessToken);
}

export async function resumeSession() {
  if (!isTauri()) return;
  refreshPromise ??= invoke<{ access_token: string | null; expires_in?: number; status?: string }>(
    'auth_resume',
  )
    .then((value) => {
      noteAccessToken(value.access_token, value.expires_in ?? 900);
      if (!value.access_token) clearMembershipCache();
    })
    .finally(() => {
      refreshPromise = null;
    });
  await refreshPromise;
}

export async function ensureFreshSession() {
  if (!isTauri()) return;
  if (accessToken && Date.now() < accessTokenExpiresAt) return;
  await resumeSession();
}

export async function initializeSession() {
  if (sessionInitialized) return;
  await resumeSession();
  sessionInitialized = true;
}

export async function apiRequest(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {},
  retry = true,
): Promise<Response> {
  if (isTauri()) {
    try {
      await ensureFreshSession();
    } catch {}
  }
  const { timeoutMs, signal, ...rest } = options;
  const headers = new Headers(rest.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  const defaultTimeout = /\/v1\/tracker\//i.test(path) ? 25_000 : 15_000;
  let response: Response;
  try {
    response = await fetch(endpoint(path), {
      ...rest,
      headers,
      signal: requestTimeoutSignal(timeoutMs ?? defaultTimeout, signal),
    });
  } catch (error) {
    throw fetchFailureApiError(error, path);
  }
  if (response.status === 401 && retry && isTauri()) {
    await resumeSession();
    if (accessToken) return apiRequest(path, options, false);
  }
  if (!response.ok) {
    let message = defaultHttpErrorMessage(response.status, path);
    let rawDetail = '';
    try {
      const body = await response.json();
      if (typeof body.detail === 'string') {
        rawDetail = body.detail;
        message = friendlyApiDetail(body.detail, path, response.status);
      } else if (body.detail?.message) {
        rawDetail = String(body.detail.message);
        message = friendlyApiDetail(rawDetail, path, response.status);
      }
    } catch {}
    if (response.status === 401) {
      message =
        'Discord session expired. Sign in again from the Home screen. A full app refresh is not required.';
    }
    throw new ApiError(message, response.status, { path, rawDetail: rawDetail || undefined });
  }
  return response;
}

export async function signIn(signal: AbortSignal, onStatus: (message: string) => void) {
  if (!isTauri())
    throw new Error(
      'Discord sign-in requires the Windows desktop app so credentials can stay in Windows Credential Manager.',
    );
  await invoke('auth_start');
  onStatus('Complete Discord sign-in in your browser. Waiting for approval…');
  const expires = Date.now() + 5 * 60 * 1000;
  while (Date.now() < expires && !signal.aborted) {
    const result = await invoke<{
      status: string;
      access_token: string | null;
      expires_in?: number;
    }>('auth_poll');
    if (result.status === 'complete') {
      noteAccessToken(result.access_token, result.expires_in ?? 900);
      sessionInitialized = true;
      return;
    }
    if (result.status === 'failed')
      throw new Error(
        'Discord sign-in failed. Close the browser tab and start again from ii Engine.',
      );
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(signal.aborted ? 'Sign-in cancelled.' : 'Sign-in expired. Try again.');
}

export async function signOut(disconnect = false) {
  let result: { message?: string } = {};
  try {
    try {
      await apiRequest('/v1/tracker/presence', { method: 'DELETE' });
    } catch {}
    const response = await apiRequest(`/v1/auth/${disconnect ? 'disconnect' : 'signout'}`, {
      method: 'POST',
    });
    if (disconnect) result = await response.json();
  } finally {
    noteAccessToken(null);
    sessionInitialized = true;
    clearMembershipCache();
    if (isTauri()) {
      await clearMenuBridge();
      await invoke('auth_clear');
    }
  }
  return result;
}

export async function deleteAccount() {
  try {
    const response = await apiRequest('/v1/me', { method: 'DELETE' });
    return (await response.json()) as { message: string; role_removed: boolean };
  } finally {
    noteAccessToken(null);
    sessionInitialized = true;
    clearMembershipCache();
    if (isTauri()) {
      await clearMenuBridge();
      await invoke('auth_clear');
    }
  }
}

export async function getDashboard(): Promise<Dashboard> {
  const response = await apiRequest('/v1/dashboard');
  return response.json() as Promise<Dashboard>;
}

export async function getSignedManifest(channel = 'stable'): Promise<Record<string, unknown>> {
  const response = await apiRequest(`/v1/manifests/${encodeURIComponent(channel)}`);
  return response.json() as Promise<Record<string, unknown>>;
}
