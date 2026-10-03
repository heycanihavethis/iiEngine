import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  askTrackerScout,
  formatScoutSeen,
  sanitizeScoutAnswer,
  scoutColorCss,
} from './trackerScoutApi';

vi.mock('./api', () => ({
  apiRequest: vi.fn(),
}));

import { apiRequest } from './api';

describe('askTrackerScout', () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockReset();
  });

  it('posts message-only payload and maps scout response', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      json: async () => ({
        answer: 'Hey! What lobby should we check?',
        remaining: 22,
        reset_at: '2026-10-02T00:00:00+00:00',
        mode: 'chat',
        searches: [],
        players: [],
        daily_limit: 24,
      }),
    } as Response);

    const result = await askTrackerScout('hi');
    expect(apiRequest).toHaveBeenCalledWith(
      '/v1/ai/tracker-scout',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ message: 'hi', share_telemetry: false }),
      }),
    );
    expect(result.mode).toBe('chat');
    expect(result.answer).toContain('Hey');
    expect(result.remaining).toBe(22);
    expect(result.players).toEqual([]);
  });

  it('maps player pills from search responses', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      json: async () => ({
        answer: 'Two players were in HI around 14:00 UTC.',
        mode: 'search',
        remaining: 20,
        hit_count: 2,
        players: [
          {
            key: 'ID:AABBCCDDEEFF0011',
            username: 'CAVERN',
            player_id: 'AABBCCDDEEFF0011',
            room: 'HI',
            region: 'EU',
            color: '255 120 40',
            platform: 'PC',
            track_kind: 'player',
            last_seen: '2026-10-01T14:05:00+00:00',
            sightings: 2,
          },
        ],
      }),
    } as Response);

    const result = await askTrackerScout('who was in room HI at 2pm today?');
    expect(result.mode).toBe('search');
    expect(result.players).toHaveLength(1);
    expect(result.players[0].username).toBe('CAVERN');
    expect(result.players[0].room).toBe('HI');
    expect(result.players[0].playerId).toBe('AABBCCDDEEFF0011');
  });
});

describe('scout helpers', () => {
  it('parses color css and relative times', () => {
    expect(scoutColorCss('255 120 40')).toBe('rgb(255, 120, 40)');
    expect(scoutColorCss('#aabbcc')).toBe('#aabbcc');
    expect(formatScoutSeen('')).toBe('');
  });

  it('strips planner JSON leaks from scout answers', () => {
    expect(
      sanitizeScoutAnswer(
        '{"mode":"search","queries":[{"field":"username","q":"finger paitners"}]}',
      ),
    ).toBe('');
    expect(sanitizeScoutAnswer('{"mode":"chat","reply":"Checking now."}')).toBe('Checking now.');
    expect(
      sanitizeScoutAnswer(
        'Saw them earlier. ```json\n{"mode":"search","queries":[{"q":"x"}]}\n``` Still looking.',
      ),
    ).toContain('Saw them earlier');
  });
});

describe('askTrackerScout blank recovery', () => {
  it('recovers when the API answer sanitizes to empty but players exist', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ok: true,
      json: async () => ({
        answer: '{"mode":"search","queries":[{"q":"x"}]}',
        mode: 'search',
        remaining: 20,
        players: [
          {
            key: 'ID:AABB',
            username: 'Recovered',
            player_id: 'AABB',
            room: 'HI',
            region: 'EU',
            color: '1 2 3',
            platform: '',
            track_kind: 'player',
            last_seen: '2026-10-01T12:00:00Z',
            sightings: 1,
          },
        ],
      }),
    } as Response);

    const result = await askTrackerScout('who was around');
    expect(result.answer.toLowerCase()).toContain('player');
    expect(result.players[0].username).toBe('Recovered');
  });
});
