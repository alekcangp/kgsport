export interface Track {
  id: string;
  name: string;
  file: string;
  distanceKm: number;
  bbox: [number, number, number, number];
  points: number;
}
