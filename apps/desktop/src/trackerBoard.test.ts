import { describe, expect, it } from 'vitest';
import {
  colorsWithinTolerance,
  groupBySimilarColor,
  groupPlayerHits,
  parseRgbTuple,
} from './trackerBoard';

const hit = (
  partial: Partial<{
    id: string;
    nick: string;
    playerId: string;
    room: string;
    region: string;
    color: string;
    timestamp: string;
  }>,
) => ({
  id: partial.id || '1',
  nick: partial.nick || 'A',
  playerId: partial.playerId || '',
  room: partial.room || '',
  region: partial.region || '',
  color: partial.color || '',
  timestamp: partial.timestamp || '2026-10-01T00:00:00.000Z',
});

describe('tracker board grouping', () => {
  it('groups by room and region', () => {
    const hits = [
      hit({ id: '1', nick: 'A', room: 'AAAA', region: 'USW' }),
      hit({ id: '2', nick: 'B', room: 'AAAA', region: 'USW' }),
      hit({ id: '3', nick: 'C', room: 'BBBB', region: 'EU' }),
    ];
    const rooms = groupPlayerHits(hits, 'rooms');
    expect(rooms).toHaveLength(2);
    expect(rooms[0].title).toBe('Room AAAA');
    expect(rooms[0].hits).toHaveLength(2);

    const regions = groupPlayerHits(hits, 'regions');
    expect(regions.map((group) => group.title).sort()).toEqual(['Region EU', 'Region USW']);
  });

  it('clusters similar colors within ±20', () => {
    expect(parseRgbTuple('255 0 0')).toEqual([255, 0, 0]);
    expect(colorsWithinTolerance('255 0 0', '250 5 10', 20)).toBe(true);
    expect(colorsWithinTolerance('255 0 0', '200 0 0', 20)).toBe(false);

    const groups = groupBySimilarColor([
      hit({ id: '1', nick: 'Red1', color: '255 0 0' }),
      hit({ id: '2', nick: 'Red2', color: '245 8 5' }),
      hit({ id: '3', nick: 'Blue', color: '0 0 255' }),
      hit({ id: '4', nick: 'None', color: '' }),
    ]);
    const redCluster = groups.find(
      (group) =>
        group.hits.some((row) => row.nick === 'Red1') &&
        group.hits.some((row) => row.nick === 'Red2'),
    );
    expect(redCluster).toBeTruthy();
    expect(redCluster?.hits).toHaveLength(2);
    expect(groups.some((group) => group.key === 'color-unknown')).toBe(true);
  });
});
