import { LOCATION } from './config';

/**
 * Текущая температура воздуха в «Крутой горке» (Омск).
 * Источник — Open-Meteo: бесплатный, без API-ключа и с поддержкой CORS.
 * Возвращает температуру в °C или null, если данных нет.
 */
export async function fetchCurrentTemperature(): Promise<number | null> {
  const params = new URLSearchParams({
    latitude: String(LOCATION.latitude),
    longitude: String(LOCATION.longitude),
    current: 'temperature_2m',
    timezone: 'auto',
  });

  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);

  const data = (await res.json()) as { current?: { temperature_2m?: unknown } };
  const value = data.current?.temperature_2m;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}