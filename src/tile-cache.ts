/** Границы в формате [запад, юг, восток, север]. */
export type Bounds = readonly [number, number, number, number];

export type UrlForTile = (z: number, x: number, y: number) => string;

const MAX_MERCATOR_LAT = 85.05112878;
const DEFAULT_PADDING = 0.3;
const IMAGERY_ZOOMS = [13, 14, 15, 16];
const TERRAIN_ZOOMS = [13, 14, 15];

/** Номер тайла по долготе (схема slippy map). */
export function lonToTileX(lon: number, zoom: number): number {
  const tiles = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * tiles);
  return Math.max(0, Math.min(tiles - 1, x));
}

/** Номер тайла по широте (схема slippy map). */
export function latToTileY(lat: number, zoom: number): number {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const rad = (clamped * Math.PI) / 180;
  const tiles = 2 ** zoom;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * tiles);
  return Math.max(0, Math.min(tiles - 1, y));
}

export function imageryTileUrl(z: number, x: number, y: number): string {
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
}

export function terrainTileUrl(z: number, x: number, y: number): string {
  return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
}

/**
 * Ссылки на тайлы, покрывающие границы, для указанных зумов.
 * padding — доля протяжённости, добавляемая с каждой стороны.
 */
export function tileUrlsForBounds(
  bounds: Bounds,
  zooms: readonly number[],
  urlForTile: UrlForTile,
  padding = 0,
): string[] {
  const west = Math.min(bounds[0], bounds[2]);
  const east = Math.max(bounds[0], bounds[2]);
  const south = Math.min(bounds[1], bounds[3]);
  const north = Math.max(bounds[1], bounds[3]);

  const padX = (east - west) * padding;
  const padY = (north - south) * padding;

  const urls = new Set<string>();
  for (const zoom of zooms) {
    const x0 = lonToTileX(west - padX, zoom);
    const x1 = lonToTileX(east + padX, zoom);
    const y0 = latToTileY(north + padY, zoom);
    const y1 = latToTileY(south - padY, zoom);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        urls.add(urlForTile(zoom, x, y));
      }
    }
  }

  return [...urls];
}

export function imageryTileUrls(bounds: Bounds, padding = DEFAULT_PADDING): string[] {
  return tileUrlsForBounds(bounds, IMAGERY_ZOOMS, imageryTileUrl, padding);
}

export function terrainTileUrls(bounds: Bounds, padding = DEFAULT_PADDING): string[] {
  return tileUrlsForBounds(bounds, TERRAIN_ZOOMS, terrainTileUrl, padding);
}

export interface NetworkInformationLike {
  saveData?: boolean;
}

/**
 * Скачивает тайлы, чтобы service worker положил их в CacheFirst-кэш.
 * Ошибки игнорируются: прогрев не должен ломать приложение.
 * maxTiles ограничивает разовый бюджет загрузки, чтобы прогрев не «съел» трафик.
 * Возвращает число успешно полученных ответов.
 */
export async function warmTileCache(urls: readonly string[], concurrency = 4, maxTiles = 600): Promise<number> {
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  if (connection?.saveData) return 0;

  const queue = [...new Set(urls)].slice(0, Math.max(0, maxTiles));
  let warmed = 0;

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const url = queue.shift()!;
      try {
        const response = await fetch(url, { mode: 'cors' });
        if (response.ok) warmed++;
      } catch {
        // офлайн или временная ошибка сети — попробуем при следующем визите
      }
    }
  });

  await Promise.all(workers);
  return warmed;
}
