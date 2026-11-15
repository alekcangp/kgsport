# СШ "Крутая горка" — интерактивная карта лыжной трассы

Веб-приложение для просмотра лыжных трасс: галерея маршрутов, карта (MapLibre), профиль высот и режим «круиз» (анимация движения по трассе), геолокация с расстоянием до трассы, скачивание исходных файлов.

## Стек

- Vite + TypeScript
- MapLibre GL
- Turf.js, @tmcw/togeojson
- Vanilla CSS (PostCSS + autoprefixer)

## Запуск

```bash
npm install
npm run dev
```

Сборка данных трасс выполняется автоматически (`build:tracks`).

## Сборка

```bash
npm run build
npm run preview
```

## Тесты и качество кода

```bash
npm run test           # unit-тесты (Vitest)
npm run test:coverage  # тесты + отчёт о покрытии
npm run lint           # ESLint
npm run format         # Prettier
```

## Данные трасс

`npm run build:tracks` разбирает файлы из `public/tracks` и генерирует `public/tracks.json`:
имя, длина, набор высоты, bbox и массив `elevations` (высоты по точкам трека).
Профиль высот строится по этим данным, поэтому он работает офлайн и без внешних API.

## Структура

- `src/` — исходный код приложения
- `scripts/build-tracks.mjs` — генерация `public/tracks.json` из файлов в `public/tracks`
- `public/tracks/` — исходные GPX трассы

## Лицензия

MIT
