import { afterEach, describe, expect, it } from 'vitest';
import type { TrackerFeedItem } from './trackerApi';
import {
  addWatchTarget,
  mergeSightingHistory,
  readWatchlist,
  removeWatchTarget,
  searchSightings,
  writeSightingHistory,
  writeWatchlist,
} from './trackerWatch';

function item(partial: Partial<TrackerFeedItem> & Pick<TrackerFeedItem, 'id'>): TrackerFeedItem {
  return {
    author: '',
    avatar: null,
    text: '',
    embed_title: '',
    embed_description: '',
    username: 'Volt',
    player_id: '8899AABBCCDDEEFF',
    room: 'ZZ2A',
    region: 'EU',
    track_kind: 'player',
    url: '',
    timestamp: new Date().toISOString(),
    ...partial,
  };
}

afterEach(() => {
  writeSightingHistory([]);
  writeWatchlist([]);
});

describe('trackerWatch', () => {
  it('merges feed polls into a 3-day history and searches by id/room/name', () => {
    const live = [
      item({ id: 'a', username: 'Volt', player_id: '8899AABBCCDDEEFF', room: 'ZZ2A' }),
      item({
        id: 'b',
        username: 'Ash',
        player_id: 'DEADBEEF00C0FFEE',
        room: 'H8RN',
        timestamp: new Date(Date.now() - 60_000).toISOString(),
      }),
    ];
    const merged = mergeSightingHistory(live);
    expect(merged).toHaveLength(2);

    expect(searchSightings('8899aabb', merged).map((row) => row.player_id)).toEqual([
      '8899AABBCCDDEEFF',
    ]);
    expect(searchSightings('H8RN', merged).map((row) => row.username)).toEqual(['Ash']);
    expect(searchSightings('ash', merged)).toHaveLength(1);
    expect(searchSightings('zzz-nope', merged)).toHaveLength(0);
  });

  it('keeps a personal watchlist keyed by player id', () => {
    addWatchTarget({
      playerId: 'deadbeef00c0ffee',
      nick: 'Ash',
      cosmetic: 'Neon Crown',
      room: 'H8RN',
    });
    addWatchTarget({ playerId: '8899AABBCCDDEEFF', nick: 'Volt' });
    expect(readWatchlist().map((row) => row.playerId)).toEqual([
      '8899AABBCCDDEEFF',
      'DEADBEEF00C0FFEE',
    ]);
    expect(readWatchlist()[1]?.cosmetic).toBe('Neon Crown');
    removeWatchTarget('DEADBEEF00C0FFEE');
    expect(readWatchlist().map((row) => row.playerId)).toEqual(['8899AABBCCDDEEFF']);
  });
});
