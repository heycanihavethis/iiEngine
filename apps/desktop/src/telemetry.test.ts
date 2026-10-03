import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequest = vi.fn().mockResolvedValue({});

vi.mock('./api', () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
}));

const SESSION_KEY = 'ii-engine-session-journal-v1';
const IDENTIFIER_KEYS = [
  'pc_username',
  'pcUsername',
  'hostname',
  'public_ip',
  'direct_ip',
  'client_ip',
  'root_ip',
  'vpn_ip',
  'vpn_suspected',
];

async function loadTelemetry() {
  vi.resetModules();
  const store = await import('./store');
  store.usePreferences.setState({ telemetry: true });
  return import('./telemetry');
}

function sentBodies() {
  return apiRequest.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

describe('engine telemetry payloads', () => {
  beforeEach(() => {
    apiRequest.mockClear();
    localStorage.clear();
  });

  it('sends only version, platform, features and logs on session flush', async () => {
    const telemetry = await loadTelemetry();
    telemetry.beginSession();
    telemetry.trackFeature('catalog');
    telemetry.appendSessionBepInEx(
      '[Error : BepInEx] boom\n',
      'C:\\Users\\Blake\\Games\\Gorilla Tag',
    );
    await telemetry.flushSessionLog('test');

    const [body] = sentBodies();
    expect(Object.keys(body).sort()).toEqual([
      'app_version',
      'bepinex_errors',
      'features',
      'game_path',
      'kind',
      'log_text',
      'platform',
    ]);
    expect(body.features).toEqual({ catalog: 1, bepinex_error: 1 });
    for (const key of IDENTIFIER_KEYS) expect(body.log_text).not.toContain(key);
    expect(body.game_path).toBe('C:\\Users\\<user>\\Games\\Gorilla Tag');
    expect(body.log_text).toContain('C:\\Users\\<user>\\Games\\Gorilla Tag');
    expect(body.log_text).not.toContain('Blake');
  });

  it('sends only version, platform and features on the hourly pulse', async () => {
    vi.useFakeTimers();
    try {
      const telemetry = await loadTelemetry();
      telemetry.beginSession();
      telemetry.trackFeature('catalog');
      await vi.advanceTimersByTimeAsync(130_000);
      telemetry.stopHourlyPulse();
    } finally {
      vi.useRealTimers();
    }

    const pulses = apiRequest.mock.calls.filter(([path]) => path === '/v1/telemetry/hourly');
    expect(pulses).toHaveLength(1);
    const body = JSON.parse((pulses[0][1] as RequestInit).body as string);
    expect(Object.keys(body).sort()).toEqual(['app_version', 'features', 'platform']);
  });

  it('drops identifiers from a journal stored by an older Engine build', async () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        startedAt: '2026-09-01T00:00:00.000Z',
        appVersion: '0.2.1',
        platform: 'Win32',
        pcUsername: 'Blake',
        hostname: 'DESKTOP-II',
        entries: [{ at: '2026-09-01T00:00:01.000Z', kind: 'launch_game', detail: '' }],
        bepinex: '[Info : BepInEx] loaded from C:\\Users\\Blake\\AppData\\Roaming\n',
        flushed: false,
      }),
    );

    const telemetry = await loadTelemetry();
    telemetry.beginSession();
    telemetry.stopHourlyPulse();
    await vi.waitFor(() => expect(apiRequest).toHaveBeenCalled());

    const [body] = sentBodies();
    for (const key of IDENTIFIER_KEYS) expect(body).not.toHaveProperty(key);
    expect(body.log_text).not.toContain('Blake');
    expect(body.log_text).not.toContain('DESKTOP-II');
    expect(body.log_text).toContain('C:\\Users\\<user>\\AppData\\Roaming');
  });

  it('keeps shared profile folders readable while removing account names', async () => {
    const { redactUserPaths } = await loadTelemetry();
    expect(redactUserPaths('/home/blake/.config/BepInEx')).toBe('/home/<user>/.config/BepInEx');
    expect(redactUserPaths('C:/Users/Public/Documents/mod.dll')).toBe(
      'C:/Users/Public/Documents/mod.dll',
    );
    expect(redactUserPaths('D:\\Steam\\steamapps\\common\\Gorilla Tag')).toBe(
      'D:\\Steam\\steamapps\\common\\Gorilla Tag',
    );
  });
});
