export interface Track {
  id: string;
  name: string;
  file: string;
  distanceKm: number;
  ascentM: number;
  bbox: [number, number, number, number];
  points: number;
  /** Высоты по точкам трека (м). Пустой массив — данных о высотах нет. */
  elevations: number[];
}
