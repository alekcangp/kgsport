import './styles.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
maplibregl.setWorkerUrl('./maplibre-gl-worker.mjs');
import QRCode from 'qrcode';
import type { Track } from './types';
import { length, lineString } from '@turf/turf';
const app = document.getElementById('app')!;

let flyMarker: maplibregl.Marker | null = null;
let elevations: number[] = [];
let currentIdx = 0;
let dists: number[] = [];



let isFlying = false;
let flyProgress = 0;
const CRUISE_STEP = 0.2;
let flyStepSize = CRUISE_STEP;
let flyRafId: number | null = null;

const SLOPE_ANGLE_DEG = 3; // порог угла наклона: больше 3° — подъём/спуск, меньше — ровно
const SAMPLE_STEP_M = 5;


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
    card.innerHTML = `<canvas class="canvas-thumb" data-id="${t.id}"></canvas><div class="p-3"><div class="font-semibold">${t.name}</div><div class="text-sm text-slate-400">${t.distanceKm} км · ↑ ${t.ascentM} м</div></div>`;
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
    minZoom: 13,
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
  document.getElementById('download')!.addEventListener('click', () => openDownloadPopup(t));
  map.on('load', () => {

      const startEl = document.createElement('div');
      startEl.className = 'track-marker start';
      startEl.textContent = 'С';
      new maplibregl.Marker({ element: startEl, anchor: 'bottom' }).setLngLat(coords[0] as [number, number]).addTo(map);
      const finishEl = document.createElement('div');
      finishEl.className = 'track-marker finish';
      finishEl.textContent = 'Ф';
      new maplibregl.Marker({ element: finishEl, anchor: 'bottom' }).setLngLat(coords[coords.length - 1] as [number, number]).addTo(map);
      flyMarker = new maplibregl.Marker({ color: '#f59e0b' }).setLngLat(coords[0] as [number, number]).addTo(map);
      {
        const el = flyMarker.getElement();
        if (el) el.style.display = 'none';
      }
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
        if (flyMarker) {
          const el = flyMarker.getElement();
          if (best === 0 || best === coords.length - 1) { el.style.display = 'none'; }
          else { el.style.display = ''; }
          flyMarker.setLngLat(coords[best] as [number, number]);
        }
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
        const results = data.results || [];
        for (let j = 0; j < batch.length; j++) {
          out.push(results[j]?.elevation ?? 0);
        }
        break;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
        if (attempt === 2) { for (let j = 0; j < batch.length; j++) out.push(0); break; }
      }
    }
  }
  return out;
}

function renderTrackSlope(coords: number[][], elevations: number[]) {
  const map = (window as any).__map;
  if (!map) return;

  // Удаляем старый одноцветный слой, если остался
  if (map.getLayer('track-line')) map.removeLayer('track-line');
  if (map.getSource('track')) map.removeSource('track');

  type SlopeType = 'ascent' | 'descent' | 'flat';

  // Накопительные дистанции между точками GPX (в метрах)
  const distsM: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    distsM.push(distsM[distsM.length - 1] + length(lineString([coords[i - 1], coords[i]]), { units: 'kilometers' }) * 1000);
  }
  const totalM = distsM[distsM.length - 1];
  if (totalM <= 0) return;

  // Сэмплируем трассу каждые SAMPLE_STEP_M метров с линейной интерполяцией высоты
  const sampleCoords: number[][] = [];
  const sampleElevs: number[] = [];
  let segIdx = 0;
  for (let d = 0; d <= totalM; d += SAMPLE_STEP_M) {
    while (segIdx < distsM.length - 1 && distsM[segIdx + 1] < d) segIdx++;
    const t = (d - distsM[segIdx]) / (distsM[segIdx + 1] - distsM[segIdx] || 1);
    const c0 = coords[segIdx], c1 = coords[segIdx + 1] || coords[segIdx];
    sampleCoords.push([c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t]);
    const nextElev = elevations[segIdx + 1] ?? elevations[segIdx];
    sampleElevs.push(elevations[segIdx] + (nextElev - elevations[segIdx]) * t);
  }

  // Сглаживаем высоты скользящим средним (окно 5 сэмплов), чтобы шум GPS не дрробил цвета
  const smoothElevs = [...sampleElevs];
  const win = 5;
  for (let i = 0; i < sampleElevs.length; i++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(sampleElevs.length - 1, i + win); j++) {
      sum += sampleElevs[j]; cnt++;
    }
    smoothElevs[i] = sum / cnt;
  }

  // Классифицируем интервалы между сэмплами (~10 м) по углу наклона и склеиваем соседние одинаковые типы
  const segments: { type: SlopeType; coords: number[][] }[] = [];
  const angleRad = (SLOPE_ANGLE_DEG * Math.PI) / 180;
  for (let i = 0; i < sampleCoords.length - 1; i++) {
    const diff = smoothElevs[i + 1] - smoothElevs[i];
    const distM = length(lineString([sampleCoords[i], sampleCoords[i + 1]]), { units: 'kilometers' }) * 1000;
    const angle = Math.atan2(diff, distM || 1);
    let type: SlopeType;
    if (angle > angleRad) type = 'ascent';
    else if (angle < -angleRad) type = 'descent';
    else type = 'flat';

    const last = segments[segments.length - 1];
    if (last && last.type === type) {
      last.coords.push(sampleCoords[i + 1]);
    } else {
      segments.push({ type, coords: [sampleCoords[i], sampleCoords[i + 1]] });
    }
  }

  const typeColors: Record<SlopeType, string> = {
    ascent: '#ef4444',   // подъём — красный
    descent: '#22c55e',  // спуск — зелёный
    flat: '#94a3b8',     // ровный — серый (только длинные ровные участки)
  };

  for (const [type, color] of Object.entries(typeColors)) {
    const feats = segments
      .filter(s => s.type === type)
      .map(s => ({ type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: s.coords } }));

    if (feats.length === 0) continue;

    const sourceId = `track-${type}`;
    const layerId = `track-${type}-line`;
    const geojson = { type: 'FeatureCollection', features: feats } as any;

    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, { type: 'geojson', data: geojson });
    } else {
      (map.getSource(sourceId) as any).setData(geojson);
    }

    if (!map.getLayer(layerId)) {
      map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        paint: { 'line-color': color, 'line-width': 4 },
      });
    }
  }
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
  // Если высоты неизвестны (все 0) — не закрашиваем трек серым
  if (!elevations.every(e => e === 0)) {
    renderTrackSlope(coords, elevations);
  }
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
  if (flyProgress >= coords.length - 1) { flyProgress = 0; }
  const i = Math.floor(flyProgress);
  const frac = flyProgress - i;
  const a = coords[i], b = coords[Math.min(i + 1, coords.length - 1)];
  const lng = a[0] + (b[0] - a[0]) * frac;
  const lat = a[1] + (b[1] - a[1]) * frac;
  if (flyMarker) {
    const el = flyMarker.getElement();
    if (i === 0 || i === coords.length - 1) { el.style.display = 'none'; }
    else { el.style.display = ''; }
    flyMarker.setLngLat([lng, lat]);
  }
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

function openDownloadPopup(t: Track) {
  const downloadUrl = new URL(`./tracks/${encodeURIComponent(t.file)}`, location.href).href;
  const existing = document.getElementById('download-popup');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'download-popup-overlay';
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4';
  overlay.innerHTML = `
    <div id="download-popup" class="bg-slate-800 rounded-2xl shadow-2xl p-6 max-w-xs w-full text-center border border-slate-600">
      <button id="download-popup-close" class="absolute top-4 right-4 text-slate-400 hover:text-white transition">
        ✕
      </button>
      <h3 class="text-lg font-bold mb-2 text-white">Загрузить трек</h3>
      <p class="text-sm text-slate-300 mb-4">${t.name}</p>
      <div class="flex items-center justify-center mb-6">
        <canvas id="download-qr" width="200" height="200" class="rounded-lg bg-white p-1 shadow"></canvas>
      </div>
      <button id="download-popup-btn" class="w-full px-4 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition shadow-lg">
        Загрузить на устройство
      </button>
      <p class="text-xs text-slate-500 mt-3">Или отсканируйте QR‑код камерой телефона</p>
    </div>
  `;

  document.body.appendChild(overlay);

  // Генерируем QR‑код с абсолютной ссылкой на трек
  QRCode.toCanvas(document.getElementById('download-qr') as HTMLCanvasElement, downloadUrl, {
    width: 200,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  }, (err) => {
    if (err) console.error('QR code error:', err);
  });

  const closePopup = () => overlay.remove();

  document.getElementById('download-popup-close')!.addEventListener('click', closePopup);
  document.getElementById('download-popup-btn')!.addEventListener('click', () => {
    downloadTrack(t.file);
    closePopup();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePopup();
  });
  const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') { closePopup(); document.removeEventListener('keydown', onEsc); } };
  document.addEventListener('keydown', onEsc);
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
  const popup = document.getElementById('download-popup-overlay');
  if (popup) popup.remove();
  if (flyMarker) { flyMarker.remove(); flyMarker = null; }
  currentIdx = 0; flyProgress = 0; isFlying = false;
  const tracks = await loadTracks();
  renderGallery(tracks);
}

init();

