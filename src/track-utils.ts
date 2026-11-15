/** Экранирует строку для вставки в HTML-разметку или атрибут. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/** Форматы, которые умеет открывать просмотрщик (KMZ пока не поддерживается). */
export function isViewableTrackFile(file: string): boolean {
  return /\.(gpx|kml)$/i.test(file);
}

/** Относительная ссылка на файл трассы с корректным кодированием имени. */
export function trackFileUrl(file: string): string {
  return `./tracks/${encodeURIComponent(file)}`;
}

/**
 * Выбирает высоты для профиля: сначала предрасчитанные при сборке,
 * затем высоты из самого трека. Пустой массив — данных нет.
 */
export function resolveElevations(precomputed: readonly number[] | undefined, coords: number[][]): number[] {
  if (Array.isArray(precomputed) && precomputed.length === coords.length) {
    return precomputed.slice();
  }
  if (coords.some((c) => (c[2] ?? 0) !== 0)) {
    return coords.map((c) => c[2] ?? 0);
  }
  return [];
}

/** Достаёт координаты из LineString или MultiLineString. */
export function lineCoordinates(geometry: unknown): number[][] {
  if (!geometry || typeof geometry !== 'object') return [];

  const { type, coordinates } = geometry as { type?: unknown; coordinates?: unknown };
  if (!Array.isArray(coordinates)) return [];

  if (type === 'LineString') {
    return coordinates.filter(isPosition);
  }

  if (type === 'MultiLineString') {
    const result: number[][] = [];
    for (const line of coordinates) {
      if (!Array.isArray(line)) continue;
      for (const position of line) {
        if (isPosition(position)) result.push(position);
      }
    }
    return result;
  }

  return [];
}

function isPosition(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length >= 2
    && typeof value[0] === 'number'
    && typeof value[1] === 'number';
}

const EARTH_RADIUS_KM = 6371.0088;

/** Расстояние по большому кругу между точками [lon, lat] в километрах. */
export function haversineKm(a: number[], b: number[]): number {
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Накопительные расстояния по точкам маршрута в километрах. */
export function cumulativeDistancesKm(coords: number[][]): number[] {
  const result = [0];
  for (let i = 1; i < coords.length; i++) {
    result.push(result[i - 1] + haversineKm(coords[i - 1], coords[i]));
  }
  return result;
}

export interface TrackPosition {
  index: number;
  fraction: number;
  lng: number;
  lat: number;
}

/** Позиция на маршруте по пройденной дистанции в километрах. */
export function positionAtDistance(
  dists: number[],
  coords: number[][],
  distanceKm: number,
): TrackPosition | null {
  if (dists.length !== coords.length || coords.length === 0) return null;

  const total = dists[dists.length - 1];
  if (!Number.isFinite(total) || total <= 0) return null;

  if (distanceKm >= total) {
    const last = coords.length - 1;
    return { index: last, fraction: 0, lng: coords[last][0], lat: coords[last][1] };
  }

  let low = 0;
  let high = dists.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (dists[mid] < distanceKm) low = mid + 1;
    else high = mid;
  }

  const index = Math.max(0, low - 1);
  const next = Math.min(index + 1, coords.length - 1);
  const segment = dists[next] - dists[index];
  const fraction = segment > 0 ? (distanceKm - dists[index]) / segment : 0;
  const a = coords[index];
  const b = coords[next];

  return {
    index,
    fraction,
    lng: a[0] + (b[0] - a[0]) * fraction,
    lat: a[1] + (b[1] - a[1]) * fraction,
  };
}

/** Значение (например, высота) на маршруте по пройденной дистанции в километрах. */
export function valueAtDistance(
  dists: number[],
  values: number[],
  distanceKm: number,
): number | null {
  if (dists.length !== values.length || values.length === 0) return null;

  const total = dists[dists.length - 1];
  if (!Number.isFinite(total) || total <= 0) return values[0];

  if (distanceKm <= 0) return values[0];
  if (distanceKm >= total) return values[values.length - 1];

  let low = 0;
  let high = dists.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (dists[mid] < distanceKm) low = mid + 1;
    else high = mid;
  }

  const index = Math.max(0, low - 1);
  const next = Math.min(index + 1, values.length - 1);
  const segment = dists[next] - dists[index];
  const fraction = segment > 0 ? (distanceKm - dists[index]) / segment : 0;

  return values[index] + (values[next] - values[index]) * fraction;
}

/**
 * Угол наклона маршрута в градусах по высотам на расстоянии distanceKm.
 * Считается по окну ±halfWindowKm, чтобы шум GPS не дёргал показатель.
 * Положительный угол — подъём, отрицательный — спуск.
 */
export function slopeAngleAtDistance(
  dists: number[],
  values: number[],
  distanceKm: number,
  halfWindowKm = 0.005,
): number | null {
  if (dists.length !== values.length || values.length < 2) return null;

  const total = dists[dists.length - 1];
  if (!Number.isFinite(total) || total <= 0) return null;

  const km = Math.min(Math.max(distanceKm, 0), total);
  const window = Math.max(0, halfWindowKm);
  const from = Math.max(0, km - window);
  const to = Math.min(total, km + window);
  const runM = (to - from) * 1000;
  if (runM <= 0) return null;

  const before = valueAtDistance(dists, values, from);
  const after = valueAtDistance(dists, values, to);
  if (before === null || after === null) return null;

  return (Math.atan2(after - before, runM) * 180) / Math.PI;
}
