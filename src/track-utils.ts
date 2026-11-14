import { length, lineString } from '@turf/turf';

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

/** Накопительные расстояния по точкам маршрута в километрах. */
export function cumulativeDistancesKm(coords: number[][]): number[] {
  const result = [0];
  for (let i = 1; i < coords.length; i++) {
    const segment = length(lineString([coords[i - 1], coords[i]]), { units: 'kilometers' });
    result.push(result[i - 1] + segment);
  }
  return result;
}
