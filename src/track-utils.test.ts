import { describe, expect, it } from 'vitest';
import { cumulativeDistancesKm, escapeHtml, isViewableTrackFile, lineCoordinates, positionAtDistance, slopeAngleAtDistance, valueAtDistance } from './track-utils';

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

describe('positionAtDistance', () => {
  const coords = [[0, 0], [1, 0], [1, 1]];
  const dists = [0, 1, 2];

  it('возвращает null для некорректных данных', () => {
    expect(positionAtDistance([], [], 0)).toBeNull();
    expect(positionAtDistance([0, 1], coords, 0.5)).toBeNull();
    expect(positionAtDistance([0, 0], [[0, 0], [1, 1]], 0)).toBeNull();
  });

  it('в начале маршрута возвращает первую точку', () => {
    expect(positionAtDistance(dists, coords, 0)).toMatchObject({ index: 0, lng: 0, lat: 0 });
  });

  it('интерполирует позицию внутри сегмента', () => {
    expect(positionAtDistance(dists, coords, 0.5)).toMatchObject({ index: 0, fraction: 0.5, lng: 0.5, lat: 0 });
    expect(positionAtDistance(dists, coords, 1.5)).toMatchObject({ index: 1, fraction: 0.5, lng: 1, lat: 0.5 });
  });

  it('в конце и за пределами маршрута возвращает последнюю точку', () => {
    expect(positionAtDistance(dists, coords, 2)).toMatchObject({ index: 2, lng: 1, lat: 1 });
    expect(positionAtDistance(dists, coords, 99)).toMatchObject({ index: 2, lng: 1, lat: 1 });
  });
});

describe('valueAtDistance', () => {
  const dists = [0, 0.1, 0.25, 0.4];
  const heights = [100, 120, 90, 110];

  it('возвращает null для некорректных данных', () => {
    expect(valueAtDistance([], [], 0)).toBeNull();
    expect(valueAtDistance([0, 1], [10], 0.5)).toBeNull();
  });

  it('линейно интерполирует внутри сегмента', () => {
    expect(valueAtDistance(dists, heights, 0.05)).toBeCloseTo(110, 6);
    expect(valueAtDistance(dists, heights, 0.175)).toBeCloseTo(105, 6);
    expect(valueAtDistance(dists, heights, 0.325)).toBeCloseTo(100, 6);
  });

  it('точно возвращает значения в узлах', () => {
    expect(valueAtDistance(dists, heights, 0.1)).toBe(120);
    expect(valueAtDistance(dists, heights, 0.25)).toBe(90);
  });

  it('зажимает значения в границах маршрута', () => {
    expect(valueAtDistance(dists, heights, -1)).toBe(100);
    expect(valueAtDistance(dists, heights, 99)).toBe(110);
  });

  it('для маршрута нулевой длины возвращает первое значение', () => {
    expect(valueAtDistance([0, 0], [50, 60], 0)).toBe(50);
  });
});

describe('slopeAngleAtDistance', () => {
  const grade10 = [0, 0.1];
  const heights = [0, 10];

  it('возвращает null для некорректных данных', () => {
    expect(slopeAngleAtDistance([], [], 0)).toBeNull();
    expect(slopeAngleAtDistance([0, 0], [10, 20], 0)).toBeNull();
    expect(slopeAngleAtDistance([0, 1], [10], 0.5)).toBeNull();
  });

  it('считает угол подъёма и спуска', () => {
    const up = slopeAngleAtDistance(grade10, heights, 0.05)!;
    expect(up).toBeCloseTo(5.710593, 5);

    const down = slopeAngleAtDistance(grade10, [10, 0], 0.05)!;
    expect(down).toBeCloseTo(-5.710593, 5);
  });

  it('на ровном участке даёт ноль', () => {
    expect(slopeAngleAtDistance([0, 1, 2], [100, 100, 100], 1)).toBeCloseTo(0, 10);
  });

  it('на краях использует одностороннее окно', () => {
    const atStart = slopeAngleAtDistance(grade10, heights, 0)!;
    const atEnd = slopeAngleAtDistance(grade10, heights, 0.1)!;
    expect(atStart).toBeCloseTo(5.710593, 5);
    expect(atEnd).toBeCloseTo(5.710593, 5);
  });

  it('не зависит от выхода за границы маршрута', () => {
    expect(slopeAngleAtDistance(grade10, heights, -5)).toBeCloseTo(5.710593, 5);
    expect(slopeAngleAtDistance(grade10, heights, 50)).toBeCloseTo(5.710593, 5);
  });
});
