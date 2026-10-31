import './styles.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Track } from './types';
import { length, lineString } from '@turf/turf';

// use only mapbox

const app = document.getElementById('app')!;

let flyMarker: maplibregl.Marker | null = null;
let elevations: number[] = [];
let currentIdx = 0;
let dists: number[] = [];



let isFlying = false;
let flyProgress = 0;
const CRUISE_STEP = 0.3;
let flyStepSize = CRUISE_STEP;
let flyRafId: number | null = null;


async function loadTracks(): Promise<Track[]> {
  const res = await fetch('./tracks.json');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function renderGallery(tracks: Track[]) {
  app.innerHTML = `<div class="p-4 max-w-6xl mx-auto"><h1 class="text-2xl font-bold mb-4">Лыжные трассы</h1><div id="grid" class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4"></div></div>`;
  const grid = document.getElementById('grid')!;
  const gpxTracks = tracks.filter(t => t.file.toLowerCase().endsWith('.gpx'));
  for (const t of gpxTracks) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<canvas class="canvas-thumb" data-id="${t.id}"></canvas><div class="p-3"><div class="font-semibold">${t.name}</div><div class="text-sm text-slate-400">${t.distanceKm} км</div></div>`;
card.addEventListener('click', () => { showViewer(t); });
    grid.appendChild(card);
  }
  for (const t of gpxTracks) drawThumbnail(t);
}

async function drawThumbnail(t: Track) {
  const canvas = document.querySelector(`canvas[data-id="${t.id}"]`) as HTMLCanvasElement;
  if (!canvas) return;
  const res = await fetch(`./tracks/${t.file}`);
  const text = await res.text();
  const coords = await parseCoords(t.file, text);
  const ctx = canvas.getContext('2d')!;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(0, 0, w, h);
  if (coords.length < 2) return;
  const xs = coords.map(c => c[0]), ys = coords.map(c => c[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs);
  const miny = Math.min(...ys), maxy = Math.max(...ys);
  const pad = 8;
  const rangeX = maxx - minx || 1, rangeY = maxy - miny || 1;
  const scale = Math.min((w - 2*pad) / rangeX, (h - 2*pad) / rangeY);
  const offX = (w - rangeX * scale) / 2;
  const offY = (h - rangeY * scale) / 2;
  const sx = (x: number) => offX + (x - minx) * scale;
  const sy = (y: number) => h - offY - (y - miny) * scale;
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2;
  ctx.beginPath();
  coords.forEach((c, i) => { const x = sx(c[0]), y = sy(c[1]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
}
function showViewer(t: Track) {
  app.innerHTML = `<div class="h-full flex flex-col"><div class="flex flex-wrap items-center gap-2 p-2 bg-slate-900"><button id="back" class="btn-ghost">← Назад</button><span class="font-semibold">${t.name}</span><span class="text-sm text-slate-400">${t.distanceKm} км</span><div class="ml-auto flex flex-wrap gap-2"><button id="cruise" class="btn">Круиз</button><button id="download" class="btn-ghost">Скачать</button></div></div><div id="map" class="flex-1"></div><canvas id="profile" class="profile-canvas"></canvas></div>`;
  document.getElementById('back')!.addEventListener('click', () => { init(); });
  initViewer(t);
}

async function initViewer(t: Track) {
  if (flyMarker) { flyMarker.remove(); flyMarker = null; }
  currentIdx = 0; flyProgress = 0; isFlying = false;
  const res = await fetch(`./tracks/${t.file}`);
  const text = await res.text();
  const coords = await parseCoords(t.file, text);

  // no token needed for Esri imagery
  const lngs = coords.map(c => c[0]), lats = coords.map(c => c[1]);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const pad = 0.05;
  const map = new (maplibregl.Map as any)({
    container: 'map',
    maxParallelRequests: 4,
    maxTileCache: 512,
    style: {
      version: 8,
      sources: {
        esri: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256 },
        terrain: { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], tileSize: 256, encoding: 'terrarium' }
      },
      layers: [{ id: 'esri-layer', type: 'raster', source: 'esri' }],
      terrain: { source: 'terrain', exaggeration: 1.5 }
    },
    center: [coords[0][0], coords[0][1]],
    zoom: 15,
    minZoom: 10,
    maxZoom: 16,
    pitch: 45,
    bearing: 0,
    maxBounds: [[minLng - pad, minLat - pad], [maxLng + pad, maxLat + pad]]
  });
  (window as any).__map = map;
  map.on('load', () => {
  });
  map.on('idle', () => { if (elevations.length === 0 || elevations.every(e => e === 0)) drawProfile(coords); });
  document.getElementById('cruise')!.addEventListener('click', () => {
    if (!isFlying) {
      isFlying = true;
      if (currentIdx >= coords.length - 1) { currentIdx = 0; flyProgress = 0; }
      else { flyProgress = currentIdx; }
      flyStepSize = 0.3;
      if (!flyMarker) flyMarker = new maplibregl.Marker({ color: '#f59e0b' }).setLngLat(coords[currentIdx] as [number, number]).addTo(map);
      document.getElementById('cruise')!.textContent = 'Стоп';
      flyRafId = requestAnimationFrame(() => flyStep(map, coords));
    } else {
      isFlying = false;
      if (flyRafId) cancelAnimationFrame(flyRafId); flyRafId = null;
      document.getElementById('cruise')!.textContent = 'Круиз';
    }
  });
  document.getElementById('download')!.addEventListener('click', () => downloadTrack(t.file));
  map.on('load', () => {
      map.addSource('track', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } } as any });
      map.addLayer({ id: 'track-line', type: 'line', source: 'track', paint: { 'line-color': '#3b82f6', 'line-width': 4 } });
      new maplibregl.Marker({ color: '#22c55e' }).setLngLat(coords[0] as [number, number]).addTo(map);
      new maplibregl.Marker({ color: '#ef4444' }).setLngLat(coords[coords.length-1] as [number, number]).addTo(map);
      flyMarker = new maplibregl.Marker({ color: '#f59e0b' }).setLngLat(coords[0] as [number, number]).addTo(map);
      drawProfile(coords);
      setTimeout(() => drawProfile(coords), 2000);
      const profileCanvas = document.getElementById('profile') as HTMLCanvasElement;
      profileCanvas.addEventListener('click', (e) => {
        const rect = profileCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const w = profileCanvas.clientWidth || 1;
        const total = dists[dists.length - 1] || 1;
        let best = 0, bestDist = Infinity;
        dists.forEach((d, idx) => {
          const px = (d / total) * w;
          const dd = Math.abs(px - x);
          if (dd < bestDist) { bestDist = dd; best = idx; }
        });
        currentIdx = best;
        flyProgress = best;
        if (flyMarker) flyMarker.setLngLat(coords[best] as [number, number]);
        else flyMarker = new maplibregl.Marker({ color: '#f59e0b' }).setLngLat(coords[best] as [number, number]).addTo((window as any).__map);
        redrawProfile();
      });

    });
}

async function fetchElevations(coords: number[][]): Promise<number[]> {
  const out: number[] = [];
  const batchSize = 100;
  for (let i = 0; i < coords.length; i += batchSize) {
    const batch = coords.slice(i, i + batchSize);
    const locs = batch.map((c) => `${c[1]},${c[0]}`).join("|");
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`https://api.opentopodata.org/v1/srtm30m?locations=${locs}`);
        if (res.status === 429 || res.status >= 500) {
          await new Promise<void>((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
          continue;
        }
        const data = await res.json();
        for (const r of data.results || []) out.push(r.elevation ?? 0);
        break;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
        if (attempt === 2) { for (let j = 0; j < batch.length; j++) out.push(0); break; }
      }
    }
  }
  return out;
}


async function drawProfile(coords: number[][]) {
  const canvas = document.getElementById('profile') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (coords.length && coords[0].length >= 3 && coords.some(c => c[2] !== 0)) {
    elevations = coords.map(c => c[2] ?? 0);
  } else {
    elevations = await fetchElevations(coords);
  }
  if (!elevations.length) return;
  dists = coords.map((_, i) => (i === 0 ? 0 : length(lineString(coords.slice(0, i + 1)), { units: 'kilometers' })));
  const miny = Math.min(...elevations), maxy = Math.max(...elevations);
  const range = maxy - miny || 1;
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2;
  ctx.beginPath();
  elevations.forEach((y, i) => {
    const x = (i / (elevations.length - 1)) * w;
    const yy = h - ((y - miny) / range) * (h - 30 ) - 14;
    if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
  });
  ctx.stroke();
  redrawProfile();
}

function redrawProfile() {
  const canvas = document.getElementById('profile') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const miny = Math.min(...elevations), maxy = Math.max(...elevations);
  const range = maxy - miny || 1;
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, w, h);
  // grid
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const gy = (g / 4) * (h - 30) + 10;
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(w, gy);
    ctx.stroke();
    const val = miny + (1 - g/4) * range;
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px sans-serif';
    ctx.fillText(val.toFixed(0) + ' м', 4, gy - 2);
  }
  // axis X distance
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px sans-serif';
  const total = dists[dists.length - 1] ?? 0;
  const step = total > 5 ? 1 : total > 2 ? 0.5 : 0.1;
  for (let km = 0; km <= total + 1e-9; km += step) {
    const x = (km / (total || 1)) * w;
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.lineTo(x, h - 5);
    ctx.strokeStyle = '#94a3b8';
    ctx.stroke();
    ctx.fillText(km.toFixed(1), x + 2, h - 6);
  }

  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2;
  ctx.beginPath();
  const hi = Math.min(currentIdx, elevations.length - 1);
  const hx = (dists[hi] / (total || 1)) * w;
  const hy = (elevations[hi] ?? 0);
  const hyy = h - ((hy - miny) / range) * (h - 30 ) - 14;
  // profile line
  if (elevations.length > 1) {
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;
    ctx.beginPath();
    elevations.forEach((y, i) => {
      const x = (dists[i] / (total || 1)) * w;
      const yy = h - ((y - miny) / range) * (h - 30 ) - 14;
      if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
    });
    ctx.stroke();
  }
  // current position marker
  ctx.fillStyle = '#f59e0b';
  ctx.beginPath();
  ctx.arc(hx, hyy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '12px sans-serif';
  const tx = Math.min(Math.max(hx + 6, 4), w - 120);
const ty = (hyy - 6 < 12) ? hyy + 14 : hyy - 6;
ctx.fillText((elevations[hi] ?? 0).toFixed(1) + ' м · ' + (dists[hi] ?? 0).toFixed(2) + ' км', tx, ty);
}


function flyStep(map: maplibregl.Map, coords: number[][]) {
  if (!isFlying) return;
  flyProgress += flyStepSize;
  if (flyProgress >= coords.length - 1) { flyProgress = coords.length - 1; isFlying = false; if (flyMarker) { flyMarker.remove(); flyMarker = null; } const btn = document.getElementById('cruise'); if (btn) btn.textContent = 'Круиз'; }
  const i = Math.floor(flyProgress);
  const frac = flyProgress - i;
  const a = coords[i], b = coords[Math.min(i + 1, coords.length - 1)];
  const lng = a[0] + (b[0] - a[0]) * frac;
  const lat = a[1] + (b[1] - a[1]) * frac;
  if (flyMarker) flyMarker.setLngLat([lng, lat]);
  try { map.panTo([lng, lat], { animate: false, duration: 0 }); } catch {}
  currentIdx = i;
  redrawProfile();
  if (isFlying) flyRafId = requestAnimationFrame(() => flyStep(map, coords));
}

function downloadTrack(file: string) {
  const a = document.createElement('a');
  a.href = `./tracks/${file}`;
  a.download = file;
  a.click();
}


async function parseCoords(file: string, text: string): Promise<number[][]> {

  const { kml, gpx } = await import('@tmcw/togeojson');
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const gj = file.endsWith('.gpx') ? gpx(doc) : kml(doc);
  for (const f of (gj as any).features || []) {
    if (f.geometry && f.geometry.type === 'LineString') return f.geometry.coordinates.map((c: number[]) => [c[0], c[1], c[2] ?? 0]);
  }
  return [];
}

async function init() {
  if (flyMarker) { flyMarker.remove(); flyMarker = null; }
  currentIdx = 0; flyProgress = 0; isFlying = false;
  const tracks = await loadTracks();
  renderGallery(tracks);
}

init();

