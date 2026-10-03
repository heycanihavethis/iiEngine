import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./telemetry', () => ({
  trackFeature: vi.fn(),
}));

describe('musicStore playback', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('rebinds audio src after refresh so play works with new object URLs', async () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const pause = vi.fn();
    const load = vi.fn();
    const audio = {
      preload: '',
      volume: 1,
      ended: false,
      src: '',
      pause,
      play,
      load,
      addEventListener: vi.fn(),
      removeAttribute: vi.fn((name: string) => {
        if (name === 'src') audio.src = '';
        if (name === 'data-track-id') audio.removeAttribute('data-track-id');
      }),
      setAttribute: vi.fn(),
      getAttribute: vi.fn(() => null),
    };
    vi.stubGlobal(
      'document',
      Object.assign(document, {
        createElement: (tag: string) => {
          if (tag === 'audio') return audio as unknown as HTMLAudioElement;
          return document.createElement(tag);
        },
      }),
    );

    const { useMusicStore } = await import('./musicStore');
    const firstUrl = 'blob:http://local/first';
    const secondUrl = 'blob:http://local/second';
    useMusicStore.setState({
      demo: true,
      ready: true,
      tracks: [
        {
          id: 'demo-soft-pulse',
          title: 'Soft Pulse',
          artist: 'ii SoundLab',
          source: 'preset',
          url: firstUrl,
        },
      ],
      index: 0,
      playing: false,
      muted: false,
      volume: 0.14,
      status: '',
    });

    await useMusicStore.getState().playAt(0);
    expect(audio.src).toBe(firstUrl);
    expect(play).toHaveBeenCalled();

    useMusicStore.setState({
      tracks: [
        {
          id: 'demo-soft-pulse',
          title: 'Soft Pulse',
          artist: 'ii SoundLab',
          source: 'preset',
          url: secondUrl,
        },
      ],
    });
    audio.setAttribute('data-track-id', 'demo-soft-pulse');
    play.mockClear();

    await useMusicStore.getState().playAt(0);
    expect(audio.src).toBe(secondUrl);
    expect(play).toHaveBeenCalled();
  });
});
