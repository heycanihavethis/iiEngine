import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { askStudioAssist, localStudioAssist, parseAiChatSse } from './studioAssist';

describe('parseAiChatSse', () => {
  it('collects token events', () => {
    const raw = [
      'event: token',
      'data: {"text":"Hello"}',
      '',
      'event: token',
      'data: {"text":" world"}',
      '',
    ].join('\n');
    expect(parseAiChatSse(raw)).toEqual({ text: 'Hello world' });
  });

  it('surfaces error events', () => {
    const raw = 'event: error\ndata: {"message":"quota"}\n\n';
    expect(parseAiChatSse(raw)).toEqual({ text: '', error: 'quota' });
  });
});

describe('askStudioAssist', () => {
  it('answers locally without an API', async () => {
    expect(localStudioAssist('How do I Harmony patch a method?').toLowerCase()).toContain('prefix');
    const result = await askStudioAssist('build failed', { demo: true });
    expect(result.source).toBe('local');
    expect(result.text.length).toBeGreaterThan(20);
  });

  it('uses the chat stream when the API succeeds', async () => {
    const request = vi.fn(async () => ({
      text: async () =>
        'event: token\ndata: {"text":"Use Build tab."}\n\nevent: done\ndata: {"remaining":3}\n\n',
    })) as unknown as (path: string, init?: RequestInit) => Promise<Response>;

    const result = await askStudioAssist('how to build', {
      demo: false,
      request,
      contextPath: 'Plugin.cs',
    });
    expect(request).toHaveBeenCalledWith(
      '/v1/ai/chat',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Plugin.cs'),
      }),
    );
    expect(result.source).toBe('api');
    expect(result.text).toContain('Build');
  });

  it('returns auth errors alongside local fallback', async () => {
    const request = vi.fn(async () => {
      throw new ApiError('Sign in to continue.', 401);
    });
    const result = await askStudioAssist('help', { demo: false, request });
    expect(result.source).toBe('local');
    expect(result.error).toMatch(/sign in/i);
  });

  it('falls back locally when the stream errors', async () => {
    const request = vi.fn(async () => ({
      text: async () => 'event: error\ndata: {"message":"quota"}\n\n',
    })) as unknown as (path: string, init?: RequestInit) => Promise<Response>;
    const result = await askStudioAssist('harmony patch help', { demo: false, request });
    expect(result.source).toBe('local');
    expect(result.error).toMatch(/quota/i);
    expect(result.text.toLowerCase()).toContain('prefix');
  });
});

describe('localStudioSelectionAction', () => {
  it('explains and summarizes offline', async () => {
    const { localStudioSelectionAction } = await import('./studioAssist');
    expect(localStudioSelectionAction('explain', 'Logger.LogInfo("x");')).toMatch(/local explain/i);
    expect(localStudioSelectionAction('summarize', 'line one\nline two')).toContain('- line one');
  });
});
