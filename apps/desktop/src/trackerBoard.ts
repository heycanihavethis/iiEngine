export type BoardHit = {
  id: string;
  nick: string;
  playerId: string;
  room: string;
  region: string;
  color: string;
  timestamp: string;
};

export type PlayerViewMode = 'list' | 'rooms' | 'regions' | 'colors';

export const PLAYER_VIEW_MODES: { id: PlayerViewMode; label: string; hint: string }[] = [
  { id: 'list', label: 'List', hint: 'Flat player cards' },
  { id: 'rooms', label: 'Rooms', hint: 'Group by lobby code' },
  { id: 'regions', label: 'Regions', hint: 'Group by region' },
  { id: 'colors', label: 'Colors', hint: 'Similar fur colors (±20)' },
];

export type BoardGroup = {
  key: string;
  title: string;
  subtitle: string;
  colorCss?: string | null;
  hits: BoardHit[];
};

export function parseRgbTuple(raw: string): [number, number, number] | null {
  const value = raw.trim();
  if (!value) return null;
  const hex = value.match(/^#?([0-9a-f]{6})$/i);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const parts = value.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 3 && parts.every((part) => /^\d{1,3}$/.test(part))) {
    const rgb = parts.map(Number) as [number, number, number];
    if (rgb.every((n) => n >= 0 && n <= 255)) return rgb;
  }
  return null;
}

export function colorsWithinTolerance(a: string, b: string, tolerance = 20): boolean {
  const left = parseRgbTuple(a);
  const right = parseRgbTuple(b);
  if (!left || !right) return false;
  return (
    Math.abs(left[0] - right[0]) <= tolerance &&
    Math.abs(left[1] - right[1]) <= tolerance &&
    Math.abs(left[2] - right[2]) <= tolerance
  );
}

function sortHits(hits: BoardHit[]) {
  return [...hits].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

function groupByKey(
  hits: BoardHit[],
  keyOf: (hit: BoardHit) => string,
  titleOf: (key: string, group: BoardHit[]) => string,
  subtitleOf: (key: string, group: BoardHit[]) => string,
): BoardGroup[] {
  const buckets = new Map<string, BoardHit[]>();
  for (const hit of hits) {
    const key = keyOf(hit);
    if (!key) continue;
    const row = buckets.get(key);
    if (row) row.push(hit);
    else buckets.set(key, [hit]);
  }
  return [...buckets.entries()]
    .map(([key, group]) => ({
      key,
      title: titleOf(key, group),
      subtitle: subtitleOf(key, group),
      hits: sortHits(group),
    }))
    .sort((a, b) => b.hits.length - a.hits.length || a.title.localeCompare(b.title));
}

export function groupBySimilarColor(hits: BoardHit[], tolerance = 20): BoardGroup[] {
  type Cluster = {
    key: string;
    seed: [number, number, number];
    sum: [number, number, number];
    count: number;
    hits: BoardHit[];
  };
  const clusters: Cluster[] = [];
  const uncolored: BoardHit[] = [];

  for (const hit of sortHits(hits)) {
    const rgb = parseRgbTuple(hit.color);
    if (!rgb) {
      uncolored.push(hit);
      continue;
    }
    let matched: Cluster | null = null;
    for (const cluster of clusters) {
      const avg: [number, number, number] = [
        Math.round(cluster.sum[0] / cluster.count),
        Math.round(cluster.sum[1] / cluster.count),
        Math.round(cluster.sum[2] / cluster.count),
      ];
      if (
        Math.abs(avg[0] - rgb[0]) <= tolerance &&
        Math.abs(avg[1] - rgb[1]) <= tolerance &&
        Math.abs(avg[2] - rgb[2]) <= tolerance
      ) {
        matched = cluster;
        break;
      }
    }
    if (!matched) {
      matched = {
        key: `color-${clusters.length}-${rgb.join('-')}`,
        seed: rgb,
        sum: [...rgb] as [number, number, number],
        count: 1,
        hits: [hit],
      };
      clusters.push(matched);
    } else {
      matched.sum[0] += rgb[0];
      matched.sum[1] += rgb[1];
      matched.sum[2] += rgb[2];
      matched.count += 1;
      matched.hits.push(hit);
    }
  }

  const groups: BoardGroup[] = clusters
    .map((cluster) => {
      const avg = [
        Math.round(cluster.sum[0] / cluster.count),
        Math.round(cluster.sum[1] / cluster.count),
        Math.round(cluster.sum[2] / cluster.count),
      ] as [number, number, number];
      return {
        key: cluster.key,
        title: `Color ${avg.join(' ')}`,
        subtitle: `${cluster.hits.length} player${cluster.hits.length === 1 ? '' : 's'} · ±${tolerance}`,
        colorCss: `rgb(${avg[0]}, ${avg[1]}, ${avg[2]})`,
        hits: sortHits(cluster.hits),
      };
    })
    .sort((a, b) => b.hits.length - a.hits.length || a.title.localeCompare(b.title));

  if (uncolored.length) {
    groups.push({
      key: 'color-unknown',
      title: 'No color',
      subtitle: `${uncolored.length} player${uncolored.length === 1 ? '' : 's'} without a color code`,
      hits: sortHits(uncolored),
    });
  }
  return groups;
}

export function groupPlayerHits(hits: BoardHit[], mode: PlayerViewMode): BoardGroup[] {
  if (mode === 'list') {
    return [
      {
        key: 'list',
        title: 'Players',
        subtitle: `${hits.length} in this view`,
        hits: sortHits(hits),
      },
    ];
  }
  if (mode === 'rooms') {
    return groupByKey(
      hits,
      (hit) => hit.room || '',
      (key) => `Room ${key}`,
      (_key, group) =>
        `${group.length} player${group.length === 1 ? '' : 's'}${
          group[0]?.region ? ` · ${group[0].region}` : ''
        }`,
    );
  }
  if (mode === 'regions') {
    return groupByKey(
      hits,
      (hit) => hit.region || '',
      (key) => `Region ${key}`,
      (_key, group) => {
        const rooms = new Set(group.map((hit) => hit.room).filter(Boolean));
        return `${group.length} player${group.length === 1 ? '' : 's'} · ${rooms.size} room${
          rooms.size === 1 ? '' : 's'
        }`;
      },
    );
  }
  return groupBySimilarColor(hits, 20);
}
