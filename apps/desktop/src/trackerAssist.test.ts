import { describe, expect, it } from 'vitest';
import { buildTrackerDigest, tryLocalTrackerAnswer } from './trackerAssist';
import { parseAssistActions } from './trackerNav';
import type { TrackerFeedItem } from './trackerApi';

function item(partial: Partial<TrackerFeedItem>): TrackerFeedItem {
  return {
    id: partial.id || 'x',
    author: partial.author || 'Tracker',
    avatar: null,
    text: partial.text || '',
    embed_title: partial.embed_title || '',
    embed_description: '',
    username: partial.username || 'Volt',
    player_id: partial.player_id || '8899AABBCCDDEEFF',
    room: partial.room || 'ZZ2A',
    region: partial.region || 'EU',
    cosmetic: partial.cosmetic || '',
    color: partial.color || '255 0 0',
    platform: partial.platform || 'PC',
    track_kind: partial.track_kind || 'player',
    timestamp: partial.timestamp || '2026-10-01T12:00:00.000Z',
    url: '',
  };
}

describe('tracker assist digest + local answers', () => {
  it('builds a compact digest under the char budget and pins question matches', () => {
    const history = Array.from({ length: 80 }, (_, index) =>
      item({
        id: `p-${index}`,
        username: `User${index}`,
        player_id: `ABCDEF${index.toString(16).padStart(10, '0')}`.slice(0, 16).toUpperCase(),
        timestamp: new Date(
          Date.parse('2026-10-01T12:00:00.000Z') - index * 3600_000,
        ).toISOString(),
      }),
    );
    history.push(
      item({
        id: 'pin',
        username: 'Needle',
        player_id: 'NEEDLE00AABBCCDD',
        timestamp: '2026-09-29T01:00:00.000Z',
      }),
    );
    const digest = buildTrackerDigest(history, {
      now: Date.parse('2026-10-01T12:30:00.000Z'),
      maxChars: 8000,
      question: 'Where is Needle?',
    });
    expect(digest.startsWith('TRACKER_DIGEST v2')).toBe(true);
    expect(digest.length).toBeLessThanOrEqual(8000);
    expect(digest).toContain('Needle');
    expect(digest.indexOf('Needle')).toBeLessThan(digest.indexOf('User0') || digest.length);
  });

  it('answers when-online locally with jump actions', () => {
    const history = [
      item({
        id: '1',
        username: 'Volt',
        player_id: '8899AABBCCDDEEFF',
        timestamp: '2026-10-01T14:10:00.000Z',
      }),
      item({
        id: '2',
        username: 'Volt',
        player_id: '8899AABBCCDDEEFF',
        timestamp: '2026-10-01T15:40:00.000Z',
        room: 'ELB3',
      }),
    ];
    const result = tryLocalTrackerAnswer('When was Volt online?', history, {
      now: Date.parse('2026-10-01T16:00:00.000Z'),
    });
    expect(result).toBeTruthy();
    expect(result?.answer).toMatch(/Volt/i);
    expect(result?.answer).toMatch(/14:00Z|15:00Z/);
    expect(result?.actions.some((action) => action.kind === 'target')).toBe(true);
    expect(result?.actions.some((action) => action.kind === 'player')).toBe(true);
  });

  it('lists who was in a room locally', () => {
    const history = [
      item({ id: '1', username: 'A', player_id: 'AAAAAAAAAAAAAAA1', room: 'ELB3' }),
      item({ id: '2', username: 'B', player_id: 'AAAAAAAAAAAAAAA2', room: 'ELB3' }),
      item({ id: '3', username: 'C', player_id: 'AAAAAAAAAAAAAAA3', room: 'ZZ2A' }),
    ];
    const result = tryLocalTrackerAnswer('Who was in room ELB3?', history, {
      now: Date.parse('2026-10-01T16:00:00.000Z'),
    });
    expect(result?.answer).toMatch(/ELB3/);
    expect(result?.answer).toMatch(/\bA\b/);
    expect(result?.answer).toMatch(/\bB\b/);
    expect(result?.answer).not.toMatch(/\bC\b/);
    expect(result?.actions.some((action) => action.kind === 'room' && action.room === 'ELB3')).toBe(
      true,
    );
  });

  it('parses assist action chips out of model text', () => {
    const parsed = parseAssistActions(
      'Volt was in ELB3.\n[[target:8899AABBCCDDEEFF]]\n[[room:ELB3]]\n[[section:players]]',
    );
    expect(parsed.text).toContain('Volt was in ELB3');
    expect(parsed.text).not.toContain('[[target:');
    expect(parsed.actions.map((action) => action.kind)).toEqual(['target', 'room', 'section']);
  });
});
