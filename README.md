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
