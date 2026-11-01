import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { kml, gpx } from '@tmcw/togeojson';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import * as turf from '@turf/turf';

const TRACKS_DIR = join(process.cwd(), 'public', 'tracks');
const OUT = join(process.cwd(), 'public', 'tracks.json');

function parseXml(text) {
  return new JSDOM(text, { contentType: 'text/xml' }).window.document;
}

function parseKmlText(text) { return kml(parseXml(text)); }
function parseGpxText(text) { return gpx(parseXml(text)); }

async function parseKmz(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const kmlFile = Object.keys(zip.files).find((f) => f.toLowerCase().endsWith('.kml'));
  if (!kmlFile) throw new Error('No KML in KMZ');
  const text = await zip.files[kmlFile].async('string');
  return parseKmlText(text);
}

function extractLine(gj) {
  if (!gj || !gj.features) return null;
  for (const f of gj.features) {
    if (f.geometry && (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString')) {
      let coords = f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates.flat();
      coords = coords.map((c) => [c[0], c[1], c[2] ?? 0]);
      return { coords, name: f.properties?.name || null };
    }
  }
  return null;
}

function ascentM(coords) {
  let gain = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = (coords[i][2] ?? 0) - (coords[i - 1][2] ?? 0);
    if (d > 0) gain += d;
  }
  return Math.round(gain);
}

function haversineKm(coords) {
  return turf.length(turf.lineString(coords), { units: 'kilometers' });
}

async function main() {
  const files = readdirSync(TRACKS_DIR).filter((f) => /\.(kml|kmz|gpx)$/i.test(f));
  const tracks = [];
  for (const file of files) {
    const full = join(TRACKS_DIR, file);
    const ext = extname(file).toLowerCase();
    let gj;
    if (ext === '.kmz') {
      gj = await parseKmz(readFileSync(full));
    } else if (ext === '.gpx') {
      gj = parseGpxText(readFileSync(full, 'utf8'));
    } else {
      gj = parseKmlText(readFileSync(full, 'utf8'));
    }
    const line = extractLine(gj);
    if (!line) continue;
    const coords = line.coords;
    const distanceKm = haversineKm(coords);
    const ascent = ascentM(coords);
    const bbox = turf.bbox(turf.lineString(coords));
    const name = line.name || basename(file, ext);
    tracks.push({
      id: basename(file, ext),
      name,
      file,
      distanceKm: Math.round(distanceKm * 100) / 100,
      ascentM: ascent,
      bbox,
      points: coords.length
    });
  }
  tracks.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(OUT, JSON.stringify(tracks, null, 2), 'utf8');
  console.log(`Generated ${tracks.length} tracks -> ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
