import { describe, expect, it } from 'vitest';
import {
  imageryTileUrl,
  imageryTileUrls,
  latToTileY,
  lonToTileX,
  terrainTileUrl,
  terrainTileUrls,
  tileUrlsForBounds,
  warmTileCache,
} from './tile-cache';

describe('lonToTileX / latToTileY', () => {
  it('центр мира в нулевом зуме', () => {
    expect(lonToTileX(0, 0)).toBe(0);
    expect(latToTileY(0, 0)).toBe(0);
  });

  it('координаты трассы 1А на зуме 16', () => {
    expect(lonToTileX(73.2166, 16)).toBe(46096);
    expect(latToTileY(55.3637, 16)).toBe(20612);
  });

  it('не выходит за границы Меркатора', () => {
    expect(latToTileY(89, 4)).toBeGreaterThanOrEqual(0);
    expect(latToTileY(-89, 4)).toBeLessThan(2 ** 4);
  });
});

describe('tileUrlsForBounds', () => {
  const bounds = [73.2158, 55.3593, 73.2179, 55.3638] as const;
  const single = (z: number) => [z];

  it('для точечных границ возвращает один тайл на зум', () => {
    const urls = tileUrlsForBounds([73.2166, 55.3637, 73.2166, 55.3637], single(16), imageryTileUrl);
    expect(urls).toEqual([imageryTileUrl(16, 46096, 20612)]);
  });

  it('padding расширяет покрытие', () => {
    const without = tileUrlsForBounds(bounds, single(16), imageryTileUrl, 0);
    const withPadding = tileUrlsForBounds(bounds, single(16), imageryTileUrl, 0.3);
    expect(withPadding.length).toBeGreaterThan(without.length);
  });

  it('не возвращает дубликаты', () => {
    const urls = tileUrlsForBounds(bounds, [13, 14, 15, 16], terrainTileUrl, 0.3);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('меняет порядок осей для источника Esri', () => {
    expect(imageryTileUrl(16, 46096, 20612)).toBe(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/16/20612/46096',
    );
    expect(terrainTileUrl(14, 3, 5)).toBe(
      'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/14/3/5.png',
    );
  });

  it('покрывает все зумы 13–16, рельеф — до 15', () => {
    const urls = imageryTileUrls(bounds);
    for (const zoom of [13, 14, 15, 16]) {
      expect(urls.some(url => url.includes(`/tile/${zoom}/`))).toBe(true);
    }
    const terrain = terrainTileUrls(bounds);
    for (const zoom of [13, 14, 15]) {
      expect(terrain.some(url => url.includes(`/terrarium/${zoom}/`))).toBe(true);
    }
    expect(terrain.some(url => url.includes('/terrarium/16/'))).toBe(false);
  });
});

describe('warmTileCache', () => {
  it('дедуплицирует ссылки и считает успешные ответы', async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return { ok: true } as Response;
    }) as typeof fetch;

    try {
      const warmed = await warmTileCache(['a', 'b', 'a'], 2);
      expect(warmed).toBe(2);
      expect(calls.sort()).toEqual(['a', 'b']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('молча пропускает ошибки сети', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch;

    try {
      await expect(warmTileCache(['a'], 1)).resolves.toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
