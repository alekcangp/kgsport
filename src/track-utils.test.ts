import { describe, expect, it } from 'vitest';
import { cumulativeDistancesKm, escapeHtml, isViewableTrackFile, lineCoordinates } from './track-utils';

describe('escapeHtml', () => {
  it('экранирует HTML-спецсимволы', () => {
    expect(escapeHtml('<b>"A&B"</b>')).toBe('&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;');
    expect(escapeHtml("O'Neil")).toBe('O&#39;Neil');
  });

  it('не меняет обычный текст', () => {
    expect(escapeHtml('Дистанция 5А')).toBe('Дистанция 5А');
  });
});

describe('isViewableTrackFile', () => {
  it('принимает GPX и KML в любом регистре', () => {
    expect(isViewableTrackFile('5A.gpx')).toBe(true);
    expect(isViewableTrackFile('5A.GPX')).toBe(true);
    expect(isViewableTrackFile('route.kml')).toBe(true);
  });

  it('не принимает KMZ и посторонние файлы', () => {
    expect(isViewableTrackFile('route.kmz')).toBe(false);
    expect(isViewableTrackFile('tracks.json')).toBe(false);
  });
});

describe('lineCoordinates', () => {
  it('возвращает координаты LineString', () => {
    expect(lineCoordinates({
      type: 'LineString',
      coordinates: [[73.1, 55.1, 100], [73.2, 55.2]],
    })).toEqual([[73.1, 55.1, 100], [73.2, 55.2]]);
  });

  it('склеивает сегменты MultiLineString', () => {
    expect(lineCoordinates({
      type: 'MultiLineString',
      coordinates: [
        [[73.1, 55.1], [73.2, 55.2]],
        [[73.3, 55.3], [73.4, 55.4]],
      ],
    })).toEqual([[73.1, 55.1], [73.2, 55.2], [73.3, 55.3], [73.4, 55.4]]);
  });

  it('игнорирует неподдерживаемые геометрии и мусор', () => {
    expect(lineCoordinates({ type: 'Point', coordinates: [73.1, 55.1] })).toEqual([]);
    expect(lineCoordinates({ type: 'LineString', coordinates: [[73.1]] })).toEqual([]);
    expect(lineCoordinates(null)).toEqual([]);
  });
});

describe('cumulativeDistancesKm', () => {
  it('начинается с нуля и растёт вдоль маршрута', () => {
    const distances = cumulativeDistancesKm([
      [73.2166, 55.3637],
      [73.2176, 55.3637],
      [73.2176, 55.3647],
    ]);

    expect(distances).toHaveLength(3);
    expect(distances[0]).toBe(0);
    expect(distances[1]).toBeGreaterThan(0);
    expect(distances[2]).toBeGreaterThan(distances[1]);
  });

  it('для одной точки возвращает один ноль', () => {
    expect(cumulativeDistancesKm([[73.2166, 55.3637]])).toEqual([0]);
  });
});
