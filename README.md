# СШ "Крутая горка" — интерактивная карта лыжной трассы

Веб-приложение для просмотра лыжных трасс: галерея маршрутов, карта (MapLibre), профиль высот и режим «круиз» (анимация движения по трассе), скачивание исходных файлов.

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

## Структура

- `src/` — исходный код приложения
- `scripts/build-tracks.mjs` — генерация `public/tracks.json` из файлов в `public/tracks`
- `public/tracks/` — исходные GPX трассы

## Лицензия

MIT
