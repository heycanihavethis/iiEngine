import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, adminErrorDetail, apiRequest, friendlyApiDetail } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('apiRequest error messages', () => {
  it('does not call HTTP 403 a network outage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ detail: 'Live tracker beta access required.' }),
      }),
    );
    try {
      await apiRequest('/v1/tracker/session', { method: 'POST' });
      expect.unreachable('expected 403');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status: 403,
        path: '/v1/tracker/session',
      });
      expect((error as ApiError).message).toMatch(/beta tracker role/i);
      expect((error as ApiError).message).not.toMatch(/can't reach the network/i);
    }
  });

  it('keeps network wording only for fetch failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(apiRequest('/v1/me')).rejects.toBeInstanceOf(ApiError);
    await expect(apiRequest('/v1/me')).rejects.toMatchObject({
      status: 0,
      message: expect.stringMatching(/can't reach the network/i),
    });
  });

  it('does not blame the user connection for tracker feed timeouts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'TimeoutError')),
    );
    await expect(apiRequest('/v1/tracker/feed')).rejects.toMatchObject({
      status: 0,
      path: '/v1/tracker/feed',
      message: expect.stringMatching(/took too long|Refresh/i),
    });
    await expect(apiRequest('/v1/tracker/feed')).rejects.toMatchObject({
      message: expect.not.stringMatching(/can't reach the network/i),
    });
  });

  it('uses tracker-specific wording for tracker fetch failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const error = await apiRequest('/v1/tracker/feed').catch((reason) => reason);
    expect(error).toMatchObject({
      status: 0,
      path: '/v1/tracker/feed',
      message: expect.stringMatching(/live tracker api|tracker backend/i),
    });
    expect(adminErrorDetail(error)).toBe('network · /v1/tracker/feed');
  });

  it('exposes admin detail with status and path', async () => {
    const error = new ApiError('Live tracker needs the beta tracker role (or staff).', 403, {
      path: '/v1/tracker/feed',
      rawDetail: 'Live tracker beta access required.',
    });
    expect(adminErrorDetail(error)).toBe(
      'HTTP 403 · /v1/tracker/feed · Live tracker beta access required.',
    );
  });

  it('labels timeouts as timeout in admin detail', () => {
    const error = new ApiError(
      'Live tracker took too long to answer. Hit Refresh in a moment.',
      0,
      {
        path: '/v1/tracker/feed',
        rawDetail: 'timeout',
      },
    );
    expect(adminErrorDetail(error)).toBe('timeout · /v1/tracker/feed');
  });
});

describe('friendlyApiDetail', () => {
  it('maps tracker 403 beta denial', () => {
    expect(
      friendlyApiDetail('Live tracker beta access required.', '/v1/tracker/session', 403),
    ).toMatch(/beta tracker role/i);
  });
});
