# micro-research-backend

Backend Microstock Research menggunakan Node.js, TypeScript, Fastify, Playwright, Crawlee, Drizzle, dan Turso.

## Menjalankan lokal

```bash
npm install
npm run dev
```

Buat file `.env` dari `.env.example`, lalu isi konfigurasi Turso, Clerk, dan `GEMINI_ENCRYPTION_KEY`.

## Validasi dan build

```bash
npm run typecheck
npm run test:scoring
npm run build
npm start
```

## Menjalankan dengan PM2

Build backend terlebih dahulu, lalu jalankan ecosystem file production:

```bash
npm ci
npm run build
pm2 start ecosystem.config.js --env production
pm2 save
pm2 status
pm2 logs micro-research-backend
```

`ecosystem.config.js` menggunakan satu instance fork, tanpa watch, dengan restart otomatis dan batas memory 400 MB. Environment rahasia tetap dibaca dari file `.env` di server dan tidak disimpan di repository.
