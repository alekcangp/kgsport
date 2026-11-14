import './styles.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Map as MapLibreMap, Marker } from 'maplibre-gl';
import QRCode from 'qrcode';
import type { Track } from './types';
import { length, lineString } from '@turf/turf';
import { cumulativeDistancesKm, escapeHtml, isViewableTrackFile, lineCoordinates, positionAtDistance } from './track-utils';
import { registerSW } from 'virtual:pwa-register';

registerSW({ immediate: true });

let maplibrePromise: Promise<typeof import('maplibre-gl')> | null = null;
function loadMaplibre() {
  maplibrePromise ??= import('maplibre-gl').then((module) => {
    module.setWorkerUrl('./maplibre-gl-worker.mjs');
    return module;
  });
  return maplibrePromise;
}

const app = document.getElementById('app')!;

let flyMarker: Marker | null = null;
let elevations: number[] = [];
let currentIdx = 0;
let dists: number[] = [];
let profileRequestId = 0;
let profileLoading = false;
let profileAttempted = false;
let viewerRequestId = 0;
let closeActiveDownloadPopup: (() => void) | null = null;
let homeVideo: HTMLVideoElement | null = null;
const logoMotionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');


let isFlying = false;
const CRUISE_SPEED_KMH = 120;
let cruiseDists: number[] = [];
let cruiseDistanceKm = 0;
let lastFrameTime: number | null = null;
let lastProfileRedraw = 0;
let flyRafId: number | null = null;

const SLOPE_ANGLE_DEG = 3; // порог угла наклона: больше 3° — подъём/спуск, меньше — ровно
const SAMPLE_STEP_M = 5;

const UI_ICONS = {
  snowflake: '<path d="M12 2v20M3.34 7l17.32 10M3.34 17 20.66 7M8 4l4 3 4-3M8 20l4-3 4 3M3 10l4-1 1-4M20 10l-4-1-1-4M3 14l4 1 1 4M20 14l-4 1-1 4"/>',
  northeast: '<path d="M7 17 17 7M8 7h9v9"/>',
  left: '<path d="M19 12H5m7 7-7-7 7-7"/>',
  down: '<path d="M12 4v16m-7-7 7 7 7-7"/>',
  play: '<path d="m8 5 12 7-12 7z" fill="currentColor" stroke="none"/>',
  close: '<path d="m18 6-12 12M6 6l12 12"/>',
} as const;

function uiIcon(name: keyof typeof UI_ICONS): string {
  return `<svg class="ui-icon ui-icon-${name}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${UI_ICONS[name]}</svg>`;
}

function isHomeScreenVisible(): boolean {
  const homeScreen = document.getElementById('home-screen');
  return !!homeScreen && !homeScreen.hidden;
}

/** Загружает видео только когда главный экран видим и анимация не отключена. */
function syncLogoMotion() {
  const video = homeVideo;
  if (!video) return;

  const shouldPlay = !logoMotionPreference.matches && isHomeScreenVisible();
  if (!shouldPlay) {
    video.pause();
    if (video.hasAttribute('src')) {
      video.removeAttribute('src');
      video.load();
    }
    return;
  }

  if (!video.hasAttribute('src')) {
    video.src = './og-video.mp4';
    video.load();
    void video.play().catch(() => {});
  }
}

logoMotionPreference.addEventListener('change', syncLogoMotion);

async function loadTracks(): Promise<Track[]> {
  const res = await fetch('./tracks.json');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: unknown = await res.json();
  if (!Array.isArray(data)) throw new Error('Некорректный формат tracks.json');
  return data as Track[];
}

function destroyMap() {
  if (flyRafId !== null) cancelAnimationFrame(flyRafId);
  flyRafId = null;
  isFlying = false;
  if (flyMarker) {
    flyMarker.remove();
    flyMarker = null;
  }
  const map = (window as any).__map as MapLibreMap | undefined;
  if (map) {
    try {
      map.remove();
    } catch {
      // Карта уже могла быть удалена.
    }
    delete (window as any).__map;
  }
}

function showLoadError(error: unknown) {
  console.error('Track loading error:', error);
  closeActiveDownloadPopup?.();
  homeVideo = null;
  destroyMap();
  app.innerHTML = `
    <div class="app-error" role="alert">
      <div class="app-error-panel">
        <span class="app-error-eyebrow">КРУТАЯ ГОРКА · ОМСК</span>
        <h1>Не удалось загрузить трассы</h1>
        <p>Проверьте подключение к интернету и попробуйте ещё раз.</p>
        <button id="retry-load" class="primary-cta" type="button">Повторить</button>
      </div>
    </div>`;
  const retryButton = document.getElementById('retry-load') as HTMLButtonElement;
  retryButton.addEventListener('click', () => {
    retryButton.disabled = true;
    void init();
  });
}

function showScreen(screen: 'home' | 'routes') {
  const homeScreen = document.getElementById('home-screen');
  const routesScreen = document.getElementById('routes-screen');
  if (!homeScreen || !routesScreen) return;

  homeScreen.hidden = screen !== 'home';
  routesScreen.hidden = screen !== 'routes';
  window.scrollTo({ top: 0, behavior: 'instant' });
  syncLogoMotion();

  if (screen === 'routes') {
    document.querySelectorAll<HTMLCanvasElement>('.canvas-thumb:not([data-drawn]):not([data-drawing])').forEach((canvas) => {
      const track = currentTracks.find(item => item.id === canvas.dataset.id);
      if (!track) return;
      canvas.dataset.drawing = 'true';
      void drawThumbnail(track)
        .then(() => { canvas.dataset.drawn = 'true'; })
        .catch(error => console.error(`Track thumbnail error (${track.file}):`, error))
        .finally(() => { delete canvas.dataset.drawing; });
    });
  }
}

let currentTracks: Track[] = [];

function renderGallery(tracks: Track[]) {
  currentTracks = tracks;
  const viewableTracks = tracks.filter(t => isViewableTrackFile(t.file));
  const maxDistanceKm = Math.max(0, ...viewableTracks.map(track => track.distanceKm));
  const maxAscentM = Math.max(0, ...viewableTracks.map(track => track.ascentM));
  const siteUrl = 'https://alekcangp.github.io/kgsport/';

  app.innerHTML = `
    <div class="landing-page">
      <main>
        <section id="home-screen" class="home-screen" aria-labelledby="hero-title">
          <header class="site-header">
            <span class="header-kicker"><span class="status-dot"></span><span>КРУТАЯ ГОРКА <i>·</i> ОМСК</span></span>
            <span class="header-link"><span class="season-icon">${uiIcon('snowflake')}</span> ЗИМНИЙ СЕЗОН</span>
          </header>
        <div class="hero-section" aria-labelledby="hero-title">
          <div class="hero-copy">
            <div class="hero-eyebrow"><span class="eyebrow-rule"></span> ЛЫЖНЫЕ МАРШРУТЫ РЯДОМ</div>
            <h1 id="hero-title">ТВОЙ ТЕМП.<br>ТВОЯ <span>ТРАССА.</span></h1>
            <p class="hero-description">Свежий воздух, снег и маршрут под настроение. Изучай трассы «Крутой горки» и выбирай свою.</p>
            <button id="show-routes" class="primary-cta" type="button">Выбрать трассу ${uiIcon('northeast')}</button>
            <div class="hero-note"><span class="hero-note-line"></span> Твой следующий день на снегу начинается здесь</div>
          </div>

          <div class="hero-side">
            <div class="hero-art">
              <div class="art-orbit art-orbit-one"></div>
              <div class="art-orbit art-orbit-two"></div>
              <div class="snowfall" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
              <span class="art-label"><span class="art-label-dot"></span> ТВОЯ ЗИМНЯЯ ТОЧКА СТАРТА</span>
              <div class="hero-logo-frame" role="img" aria-label="Крутая горка — лыжные трассы">
                <video id="hero-logo-video" class="hero-logo-video" autoplay muted loop playsinline preload="none" poster="./og-image.png" aria-hidden="true"></video>
                <img class="hero-logo-fallback" src="./og-image.png" alt="" aria-hidden="true">
              </div>
              <span class="art-coordinate">55°21′N &nbsp; 73°13′E</span>
            </div>
          </div>
          <div class="hero-bottom">
            <div class="hero-facts" aria-label="Кратко о трассах">
              <div class="hero-fact"><strong>${viewableTracks.length}</strong><span>МАРШРУТОВ</span></div>
              <div class="hero-fact"><strong>${maxDistanceKm.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}<i> км</i></strong><span>МАКС. ДЛИНА</span></div>
              <div class="hero-fact"><strong>${maxAscentM}<i> м</i></strong><span>НАБОР ВЫСОТЫ</span></div>
            </div>
            <div class="hero-qr-card">
              <div class="qr-frame"><canvas id="site-qr" width="144" height="144" aria-label="QR-код сайта Крутая горка"></canvas></div>
              <div class="qr-copy"><strong>Все трассы<br>на телефоне</strong><span class="qr-overline">Ссылка на сайт</span></div>
            </div>
          </div>

        </div>
        </section>

        <section id="routes-screen" class="routes-screen" aria-labelledby="routes-title" hidden>
          <header class="routes-header">
            <button id="show-home" class="back-home" type="button">${uiIcon('left')} На главную</button>
            <span class="routes-brand">КРУТАЯ ГОРКА <i>·</i> ОМСК</span>
          </header>
          <div class="routes-section">
            <div class="section-heading">
              <div><div class="section-eyebrow"><span>01</span> ВЫБИРАЙ И ВЫХОДИ</div><h2 id="routes-title">Маршруты <span>на любой темп</span></h2></div>
              <div class="route-highlights" aria-label="Краткая информация о трассах">
                <div class="route-highlight"><span>МАРШРУТОВ</span><strong>${viewableTracks.length}</strong></div>
                <div class="route-highlight"><span>МАКС. ДЛИНА</span><strong>${maxDistanceKm.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} <i>км</i></strong></div>
                <div class="route-highlight"><span>НАБОР ВЫСОТЫ</span><strong>до ${maxAscentM} <i>м</i></strong></div>
              </div>
            </div>
            <div id="grid" class="track-grid"></div>
            <div class="routes-footer"><span>КРУТАЯ ГОРКА · ОМСК</span><span>ВСТРЕТИМСЯ НА ТРАССЕ ${uiIcon('northeast')}</span></div>
          </div>
        </section>
      </main>
    </div>`;

  document.getElementById('show-routes')!.addEventListener('click', () => showScreen('routes'));
  document.getElementById('show-home')!.addEventListener('click', () => showScreen('home'));

  homeVideo = document.getElementById('hero-logo-video') as HTMLVideoElement | null;

  const grid = document.getElementById('grid')!;
  if (viewableTracks.length === 0) {
    grid.innerHTML = '<p class="routes-empty">Пока нет доступных маршрутов.</p>';
  }
  for (const t of viewableTracks) {
    const card = document.createElement('div');
    card.className = 'track-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${t.name}, ${t.distanceKm} километра, набор высоты ${t.ascentM} метров`);
    const trackName = escapeHtml(t.name);
    const trackId = escapeHtml(t.id);
    card.innerHTML = `
      <div class="track-art">
        <canvas class="canvas-thumb" data-id="${trackId}" aria-hidden="true"></canvas>
        <span class="track-open">${uiIcon('northeast')}</span>
      </div>
      <div class="track-card-content">
        <div class="track-title-row"><h3>${trackName}</h3></div>
        <div class="track-distance"><strong>${t.distanceKm.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}</strong><span>км</span></div>
        <div class="track-card-bottom"><span class="distance-label">ПРОТЯЖЁННОСТЬ МАРШРУТА</span><span class="track-ascent">${uiIcon('northeast')} ${t.ascentM} м <i>набор высоты</i></span></div>
      </div>`;
    const openTrack = () => showViewer(t);
    card.addEventListener('click', openTrack);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openTrack();
      }
    });
    grid.appendChild(card);
  }
  QRCode.toCanvas(document.getElementById('site-qr') as HTMLCanvasElement, siteUrl, {
    width: 144,
    margin: 1,
    color: { dark: '#10251f', light: '#ffffff' },
  }, (err) => {
    if (err) console.error('QR code error:', err);
  });
}

async function drawThumbnail(t: Track) {
  const canvas = Array.from(document.querySelectorAll<HTMLCanvasElement>('.canvas-thumb'))
    .find((item) => item.dataset.id === t.id);
  if (!canvas) return;
  const res = await fetch(`./tracks/${encodeURIComponent(t.file)}`);
  if (!res.ok) throw new Error(`Не удалось загрузить маршрут ${t.file}: HTTP ${res.status}`);
  const text = await res.text();
  const coords = await parseCoords(t.file, text);
  const ctx = canvas.getContext('2d')!;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.fillStyle = '#152821';
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
  ctx.strokeStyle = 'rgba(199, 246, 87, 0.12)';
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  coords.forEach((c, i) => { const x = sx(c[0]), y = sy(c[1]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
  ctx.strokeStyle = '#c7f657';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  coords.forEach((c, i) => { const x = sx(c[0]), y = sy(c[1]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
}
function showViewer(t: Track) {
  const requestId = ++viewerRequestId;
  homeVideo = null;
  const trackName = escapeHtml(t.name);
  const fileFormat = t.file.toLowerCase().endsWith('.kml') ? 'KML' : 'GPX';
  app.innerHTML = `
    <div class="map-view">
      <header class="map-toolbar">
        <button id="back" class="map-back" type="button">${uiIcon('left')} К трассам</button>
        <div class="map-track-heading"><h1>${trackName}</h1></div>
        <div class="map-track-distance"><strong>${t.distanceKm.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}</strong><span>КМ</span></div>
        <div class="map-actions"><button id="cruise" class="map-action map-action-primary" type="button">${uiIcon('play')} Круиз</button><button id="download" class="map-action" type="button">${uiIcon('down')} ${fileFormat}</button></div>
      </header>
      <div id="map" class="track-map"></div>
      <section class="profile-panel" aria-label="Профиль высот маршрута">
        <div class="profile-heading"><strong>ПРОФИЛЬ ВЫСОТ</strong><span>Нажмите на график, чтобы посмотреть точку маршрута</span></div>
        <canvas id="profile" class="profile-canvas"></canvas>
      </section>
    </div>`;
  document.getElementById('back')!.addEventListener('click', () => { returnToGallery(); });
  void initViewer(t, requestId).catch((error: unknown) => {
    if (requestId !== viewerRequestId) return;
    const mapContainer = document.getElementById('map');
    if (mapContainer) mapContainer.textContent = 'Не удалось загрузить маршрут. Вернитесь к списку трасс и попробуйте ещё раз.';
    console.error('Track loading error:', error);
  });
}

async function returnToGallery() {
  viewerRequestId++;
  profileRequestId++;
  profileLoading = false;
  profileAttempted = false;
  elevations = [];
  dists = [];
  destroyMap();

  try {
    const tracks = currentTracks.length ? currentTracks : await loadTracks();
    renderGallery(tracks);
    showScreen('routes');
  } catch (error) {
    showLoadError(error);
  }
}

async function initViewer(t: Track, requestId: number) {
  profileRequestId++;
  profileLoading = false;
  profileAttempted = false;
  elevations = [];
  dists = [];
  if (flyMarker) { flyMarker.remove(); flyMarker = null; }
  currentIdx = 0; isFlying = false;
  const res = await fetch(`./tracks/${t.file}`);
  if (requestId !== viewerRequestId) return;
  if (!res.ok) throw new Error(`Не удалось загрузить маршрут ${t.file}: HTTP ${res.status}`);
  const text = await res.text();
  if (requestId !== viewerRequestId) return;
  const coords = await parseCoords(t.file, text);
  if (requestId !== viewerRequestId) return;
  if (coords.length < 2) throw new Error(`В маршруте ${t.file} недостаточно точек`);
  const maplibre = await loadMaplibre();
  if (requestId !== viewerRequestId) return;

  // no token needed for Esri imagery
  const lngs = coords.map(c => c[0]), lats = coords.map(c => c[1]);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const pad = 0.05;
  const map = new maplibre.Map({
    container: 'map',
    maxTileCacheSize: 512,
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
  map.on('idle', () => {
    if (!profileAttempted) {
      profileAttempted = true;
      void drawProfile(coords, requestId).catch(error => console.error('Profile drawing error:', error));
    }
  });
  const cruiseButton = document.getElementById('cruise') as HTMLButtonElement;
  const setCruiseState = (active: boolean) => {
    cruiseButton.innerHTML = active ? `${uiIcon('close')} Стоп` : `${uiIcon('play')} Круиз`;
  };
  cruiseButton.addEventListener('click', () => {
    if (!isFlying) {
      isFlying = true;
      if (currentIdx >= coords.length - 1) currentIdx = 0;
      cruiseDists = dists.length === coords.length ? dists : cumulativeDistancesKm(coords);
      cruiseDistanceKm = cruiseDists[currentIdx] ?? 0;
      lastFrameTime = null;
      lastProfileRedraw = 0;
      if (!flyMarker) flyMarker = new maplibre.Marker({ color: '#f59e0b' }).setLngLat(coords[currentIdx] as [number, number]).addTo(map);
      setCruiseState(true);
      flyRafId = requestAnimationFrame((timestamp) => flyStep(map, coords, timestamp));
    } else {
      isFlying = false;
      if (flyRafId) cancelAnimationFrame(flyRafId); flyRafId = null;
      setCruiseState(false);
    }
  });
  document.getElementById('download')!.addEventListener('click', () => openDownloadPopup(t));
  map.on('load', () => {

      const startEl = document.createElement('div');
      startEl.className = 'track-marker start';
      startEl.textContent = 'С';
      new maplibre.Marker({ element: startEl, anchor: 'bottom' }).setLngLat(coords[0] as [number, number]).addTo(map);
      const finishEl = document.createElement('div');
      finishEl.className = 'track-marker finish';
      finishEl.textContent = 'Ф';
      new maplibre.Marker({ element: finishEl, anchor: 'bottom' }).setLngLat(coords[coords.length - 1] as [number, number]).addTo(map);
      flyMarker = new maplibre.Marker({ color: '#f59e0b' }).setLngLat(coords[0] as [number, number]).addTo(map);
      {
        const el = flyMarker.getElement();
        if (el) el.style.display = 'none';
      }
      profileAttempted = true;
      void drawProfile(coords, requestId).catch(error => console.error('Profile drawing error:', error));
      setTimeout(() => {
        if (requestId === viewerRequestId) {
          void drawProfile(coords, requestId).catch(error => console.error('Profile drawing error:', error));
        }
      }, 2000);
      const profileCanvas = document.getElementById('profile') as HTMLCanvasElement;
      profileCanvas.addEventListener('click', (e) => {
        if (!dists.length) return;
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
        if (isFlying) {
          cruiseDists = dists.length === coords.length ? dists : cumulativeDistancesKm(coords);
          cruiseDistanceKm = cruiseDists[best] ?? 0;
          lastFrameTime = null;
        }
        if (flyMarker) {
          const el = flyMarker.getElement();
          if (best === 0 || best === coords.length - 1) { el.style.display = 'none'; }
          else { el.style.display = ''; }
          flyMarker.setLngLat(coords[best] as [number, number]);
        }
        else flyMarker = new maplibre.Marker({ color: '#f59e0b' }).setLngLat(coords[best] as [number, number]).addTo(map);
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
    let completed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`https://api.opentopodata.org/v1/srtm30m?locations=${locs}`);
        if (res.status === 429 || res.status >= 500) {
          await new Promise<void>((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
          continue;
        }
        if (!res.ok) {
          out.push(...batch.map(() => 0));
          completed = true;
          break;
        }
        const data = await res.json();
        const results = data.results || [];
        for (let j = 0; j < batch.length; j++) {
          out.push(results[j]?.elevation ?? 0);
        }
        completed = true;
        break;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
      }
    }
    if (!completed) out.push(...batch.map(() => 0));
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
    flat: '#94a3b8',     // ровный — серый
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


async function drawProfile(coords: number[][], requestId = viewerRequestId) {
  const canvas = document.getElementById('profile') as HTMLCanvasElement | null;
  if (requestId !== viewerRequestId || !canvas || profileLoading || coords.length < 2) return;

  const profileId = ++profileRequestId;
  profileLoading = true;
  try {
    let nextElevations: number[];
    if (coords.length && coords[0].length >= 3 && coords.some(c => c[2] !== 0)) {
      nextElevations = coords.map(c => c[2] ?? 0);
    } else {
      nextElevations = await fetchElevations(coords);
    }
    if (requestId !== viewerRequestId || profileId !== profileRequestId || document.getElementById('profile') !== canvas) return;
    if (!nextElevations.length) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    elevations = nextElevations;
    dists = cumulativeDistancesKm(coords);
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
    ctx.scale(devicePixelRatio, devicePixelRatio);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    // Если высоты неизвестны (все 0) — не закрашиваем трек серым
    if (!elevations.every(e => e === 0)) {
      renderTrackSlope(coords, elevations);
    }
    const miny = Math.min(...elevations), maxy = Math.max(...elevations);
    const range = maxy - miny || 1;
    ctx.fillStyle = '#10251f';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#c7f657';
    ctx.lineWidth = 2;
    ctx.beginPath();
    elevations.forEach((y, i) => {
      const x = (i / (elevations.length - 1)) * w;
      const yy = h - ((y - miny) / range) * (h - 30 ) - 14;
      if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
    });
    ctx.stroke();
    redrawProfile();
  } finally {
    if (profileId === profileRequestId) profileLoading = false;
  }
}

function redrawProfile() {
  if (!elevations.length || !dists.length) return;
  const canvas = document.getElementById('profile') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const miny = Math.min(...elevations), maxy = Math.max(...elevations);
  const range = maxy - miny || 1;
  ctx.fillStyle = '#10251f';
  ctx.fillRect(0, 0, w, h);
  // grid
  ctx.strokeStyle = 'rgba(225, 232, 216, .16)';
  ctx.lineWidth = 1;
  const gridIntervals = Math.max(1, Math.min(4, Math.floor((h - 30) / 28)));
  for (let g = 0; g <= gridIntervals; g++) {
    const fraction = g / gridIntervals;
    const gy = fraction * (h - 30) + 10;
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(w, gy);
    ctx.stroke();
    const val = miny + (1 - fraction) * range;
    ctx.fillStyle = '#bdc7b8';
    ctx.font = '10px sans-serif';
    ctx.fillText(val.toFixed(0) + ' м', 4, gy - 2);
  }
  // axis X distance
  ctx.fillStyle = '#bdc7b8';
  ctx.font = '10px sans-serif';
  const total = dists[dists.length - 1] ?? 0;
  const step = total > 5 ? 1 : total > 2 ? 0.5 : 0.1;
  for (let km = 0; km <= total + 1e-9; km += step) {
    const x = (km / (total || 1)) * w;
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.lineTo(x, h - 5);
    ctx.strokeStyle = '#718274';
    ctx.stroke();
    ctx.fillText(km.toFixed(1), x + 2, h - 6);
  }

  ctx.strokeStyle = '#c7f657';
  ctx.lineWidth = 2;
  ctx.beginPath();
  const hi = Math.min(currentIdx, elevations.length - 1);
  const hx = (dists[hi] / (total || 1)) * w;
  const hy = (elevations[hi] ?? 0);
  const hyy = h - ((hy - miny) / range) * (h - 30 ) - 14;
  // profile line
  if (elevations.length > 1) {
    ctx.strokeStyle = '#c7f657';
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
  ctx.fillStyle = '#f3f1e8';
  ctx.beginPath();
  ctx.arc(hx, hyy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f3f1e8';
  ctx.font = '600 12px sans-serif';
  const label = (elevations[hi] ?? 0).toFixed(1) + ' м · ' + (dists[hi] ?? 0).toFixed(2) + ' км';
  const labelPadding = 6;
  const labelWidth = ctx.measureText(label).width + labelPadding * 2;
  const labelX = Math.min(Math.max(hx + 6, 4), Math.max(4, w - labelWidth - 4));
  const labelY = Math.max(2, Math.min((hyy - 6 < 12) ? hyy + 2 : hyy - 18, h - 22));
  ctx.fillStyle = 'rgba(7, 20, 16, .92)';
  ctx.fillRect(labelX, labelY, labelWidth, 20);
  ctx.strokeStyle = 'rgba(199, 246, 87, .75)';
  ctx.lineWidth = 1;
  ctx.strokeRect(labelX + .5, labelY + .5, labelWidth - 1, 19);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, labelX + labelPadding, labelY + 14);
}


function flyStep(map: MapLibreMap, coords: number[][], timestamp: number) {
  if (!isFlying) return;

  const total = cruiseDists[cruiseDists.length - 1] ?? 0;
  if (!(total > 0)) return;
  if (lastFrameTime !== null) {
    const deltaSeconds = Math.min((timestamp - lastFrameTime) / 1000, 0.1);
    cruiseDistanceKm = (cruiseDistanceKm + (CRUISE_SPEED_KMH / 3600) * deltaSeconds) % total;
  }
  lastFrameTime = timestamp;

  const position = positionAtDistance(cruiseDists, coords, cruiseDistanceKm);
  if (!position) return;

  const i = position.index;
  if (flyMarker) {
    const el = flyMarker.getElement();
    if (i === 0 || i === coords.length - 1) { el.style.display = 'none'; }
    else { el.style.display = ''; }
    flyMarker.setLngLat([position.lng, position.lat]);
  }
  try { map.panTo([position.lng, position.lat], { animate: false, duration: 0 }); } catch {}
  currentIdx = i;
  if (timestamp - lastProfileRedraw >= 100) {
    lastProfileRedraw = timestamp;
    redrawProfile();
  }
  if (isFlying) flyRafId = requestAnimationFrame((nextTimestamp) => flyStep(map, coords, nextTimestamp));
}

function downloadTrack(file: string) {
  const a = document.createElement('a');
  a.href = `./tracks/${encodeURIComponent(file)}`;
  a.download = file;
  a.click();
}

function openDownloadPopup(t: Track) {
  const downloadUrl = new URL(`./tracks/${encodeURIComponent(t.file)}`, location.href).href;
  const fileFormat = t.file.toLowerCase().endsWith('.kml') ? 'KML' : 'GPX';
  closeActiveDownloadPopup?.();
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const overlay = document.createElement('div');
  overlay.id = 'download-popup-overlay';
  overlay.className = 'download-popup-overlay';
  overlay.innerHTML = `
    <section id="download-popup" class="download-popup" role="dialog" aria-modal="true" aria-labelledby="download-popup-title">
      <button id="download-popup-close" class="download-popup-close" type="button" aria-label="Закрыть окно">
        ${uiIcon('close')}
      </button>
      <span class="download-popup-eyebrow">ФАЙЛ МАРШРУТА</span>
      <h2 id="download-popup-title" class="download-popup-title">Загрузить трек</h2>
      <p class="download-popup-track">${escapeHtml(t.name)}</p>
      <div class="download-popup-qr-frame">
        <canvas id="download-qr" width="200" height="200" class="download-popup-qr" aria-label="QR-код для загрузки ${fileFormat}-маршрута"></canvas>
      </div>
      <button id="download-popup-btn" class="download-popup-button" type="button">
        ${uiIcon('down')}
        Загрузить на устройство
      </button>
      <p class="download-popup-hint">Или отсканируйте QR‑код камерой телефона</p>
    </section>
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

  const closeButton = document.getElementById('download-popup-close') as HTMLButtonElement;
  const downloadButton = document.getElementById('download-popup-btn') as HTMLButtonElement;
  const onEsc = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePopup();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = [closeButton, downloadButton];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const closePopup = () => {
    overlay.remove();
    document.removeEventListener('keydown', onEsc);
    if (closeActiveDownloadPopup === closePopup) closeActiveDownloadPopup = null;
    if (previouslyFocused?.isConnected) previouslyFocused.focus();
  };
  closeActiveDownloadPopup = closePopup;

  closeButton.addEventListener('click', closePopup);
  downloadButton.addEventListener('click', () => {
    downloadTrack(t.file);
    closePopup();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePopup();
  });
  document.addEventListener('keydown', onEsc);
  closeButton.focus();
}


async function parseCoords(file: string, text: string): Promise<number[][]> {
  const { kml, gpx } = await import('@tmcw/togeojson');
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const gj = /\.gpx$/i.test(file) ? gpx(doc) : kml(doc);
  for (const f of (gj as any).features || []) {
    const coords = lineCoordinates(f.geometry);
    if (coords.length >= 2) return coords.map((c) => [c[0], c[1], c[2] ?? 0]);
  }
  return [];
}

async function init() {
  closeActiveDownloadPopup?.();
  destroyMap();
  profileRequestId++;
  profileLoading = false;
  profileAttempted = false;
  elevations = [];
  dists = [];
  currentIdx = 0;
  try {
    const tracks = await loadTracks();
    renderGallery(tracks);
    showScreen('home');
  } catch (error) {
    showLoadError(error);
  }
}

void init();

