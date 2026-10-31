# КГ Спорт — интерактивный просмотр лыжных трасс

Веб-приложение для просмотра лыжных трасс: галерея маршрутов, карта (MapLibre), профиль высот и режим «круиз» (анимация движения по трассе), скачивание исходных файлов.

## Стек

- Vite + TypeScript
- MapLibre GL
- Turf.js, @tmcw/togeojson
- Tailwind CSS

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

## Тесты

```bash
npm run test
```

## Структура

- `src/` — исходный код приложения
- `scripts/build-tracks.mjs` — генерация `public/tracks.json` из файлов в `public/tracks`
- `public/tracks/` — исходные GPX трассы

## Лицензия

MIT
