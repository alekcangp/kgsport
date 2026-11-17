import { LOCATION } from './config';

/** Таймаут запроса, чтобы интерфейс не ждал «зависшую» сеть. */
const REQUEST_TIMEOUT_MS = 8000;

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Основной источник — Open-Meteo: бесплатный, без ключа, с поддержкой CORS. */
async function fetchFromOpenMeteo(): Promise<number | null> {
  const params = new URLSearchParams({
    latitude: String(LOCATION.latitude),
    longitude: String(LOCATION.longitude),
    current: 'temperature_2m',
    timezone: 'auto',
  });
  const data = (await fetchJson(`https://api.open-meteo.com/v1/forecast?${params.toString()}`)) as {
    current?: { temperature_2m?: unknown };
  };
  const value = data.current?.temperature_2m;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Резервный источник — met.no (Норвежский метеорологический институт).
 * Тоже без ключа и с CORS; берём первый шаг прогноза «сейчас».
 */
async function fetchFromMetNo(): Promise<number | null> {
  const params = new URLSearchParams({ lat: String(LOCATION.latitude), lon: String(LOCATION.longitude) });
  const data = (await fetchJson(
    `https://api.met.no/weatherapi/locationforecast/2.0/compact?${params.toString()}`,
  )) as { properties?: { timeseries?: Array<{ data?: { instant?: { details?: { air_temperature?: unknown } } } }> } };
  const value = data.properties?.timeseries?.[0]?.data?.instant?.details?.air_temperature;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Текущая температура воздуха в «Крутой горке» (Омск).
 * Сначала Open-Meteo, при сбое — met.no. Возвращает температуру в °C или null.
 */
export async function fetchCurrentTemperature(): Promise<number | null> {
  try {
    const value = await fetchFromOpenMeteo();
    if (value !== null) return value;
  } catch {
    // Open-Meteo недоступен — пробуем запасной источник.
  }
  return fetchFromMetNo();
}