import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/maplibre-gl')) return 'maplibre-gl';
          if (id.includes('node_modules/@turf')) return 'turf';
          if (id.includes('node_modules/qrcode')) return 'qrcode';
        },
      },
    },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['og-video.mp4'],
      manifest: {
        name: 'Крутая горка',
        short_name: 'Крутая горка',
        description: 'Интерактивный просмотр лыжных трасс',
        lang: 'ru',
        theme_color: '#102536',
        background_color: '#102536',
        display: 'standalone',
        orientation: 'any',
        start_url: './',
        scope: './',
        categories: ['sports', 'navigation', 'maps'],
        icons: [
          { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          { src: './icons/icon-192.png', sizes: '180x180', type: 'image/png', purpose: 'apple touch icon' }
        ],
        screenshots: [
          {
            src: './og-image.png',
            sizes: '1200x630',
            type: 'image/png',
            form_factor: 'wide',
            label: 'Интерактивная карта лыжной трассы «Крутая горка»'
          }
        ]
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,json,kml,gpx,mjs,webmanifest}'],
        globIgnores: ['icons/**', 'manifest.webmanifest', 'assets/maplibre-gl-*.js'],
        runtimeCaching: [
          {
            urlPattern: /\/assets\/maplibre-gl-[^/]+\.js$/,
            handler: 'CacheFirst',
            options: { cacheName: 'maplibre-runtime', expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 30 } }
          },
          {
            urlPattern: /^https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/\d+\/\d+\/\d+(?:\/.*)?(?:\?.*)?$/i,
            handler: 'CacheFirst',
            options: { cacheName: 'esri-imagery-tiles', expiration: { maxEntries: 1000, maxAgeSeconds: 60 * 60 * 24 * 30 } }
          },
          {
            urlPattern: /^https:\/\/s3\.amazonaws\.com\/elevation-tiles-prod\/terrarium\/\d+\/\d+\/\d+\.png(?:\?.*)?$/i,
            handler: 'CacheFirst',
            options: { cacheName: 'terrain-tiles', expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 } }
          }
        ]
      }
    })
  ],
  optimizeDeps: { exclude: ['maplibre-gl'] },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/track-utils.ts', 'src/tile-cache.ts'],
    },
  },
});
