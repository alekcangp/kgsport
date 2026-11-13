import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  build: { outDir: 'dist', sourcemap: true },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['maplibre-gl-worker.mjs', 'og-image.png', 'icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: 'Крутая горка',
        short_name: 'Горка',
        description: 'Интерактивный просмотр лыжных трасс',
        lang: 'ru',
        theme_color: '#0a1713',
        background_color: '#0a1713',
        display: 'standalone',
        orientation: 'any',
        icons: [
          { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,json,kml,gpx,mjs,webmanifest}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/\d+\/\d+\/\d+(?:\/.*)?(?:\?.*)?$/i,
            handler: 'CacheFirst',
            options: { cacheName: 'esri-imagery-tiles', expiration: { maxEntries: 256, maxAgeSeconds: 60 * 60 * 24 * 30 } }
          },
          {
            urlPattern: /^https:\/\/s3\.amazonaws\.com\/elevation-tiles-prod\/terrarium\/\d+\/\d+\/\d+\.png(?:\?.*)?$/i,
            handler: 'CacheFirst',
            options: { cacheName: 'terrain-tiles', expiration: { maxEntries: 256, maxAgeSeconds: 60 * 60 * 24 * 30 } }
          }
        ]
      }
    })
  ],
  optimizeDeps: { exclude: ['maplibre-gl'] },
});
