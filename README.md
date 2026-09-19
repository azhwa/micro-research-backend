# micro-research-backend

Backend Microstock Research menggunakan Node.js, TypeScript, Fastify, Playwright, Crawlee, Drizzle, dan Turso.

## Menjalankan lokal

```bash
npm install
npm run dev
```

Buat file `.env` dari `.env.example`, lalu isi konfigurasi Turso, login pribadi, dan `GEMINI_ENCRYPTION_KEY`.

Untuk membuat hash password login:

```bash
npm run auth:hash -- 'password-anda'
```

Masukkan hasilnya ke `AUTH_PASSWORD_HASH`, lalu isi `AUTH_USERNAME` dan buat nilai acak panjang untuk `AUTH_SESSION_SECRET`.
Login menggunakan HttpOnly session cookie; Clerk tidak diperlukan.

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

`ecosystem.config.js` menggunakan satu instance fork, tanpa watch, dengan restart otomatis dan batas memory 550 MB. Batas ini hanya untuk proses aplikasi yang dipantau PM2; Chromium Playwright dan `cloudflared` tetap perlu dipantau dari total penggunaan RAM VPS. Environment rahasia tetap dibaca dari file `.env` di server dan tidak disimpan di repository.

Deployment saat ini menargetkan Ubuntu 20.04, sehingga versi Playwright dikunci ke `1.62.1`. Jangan menaikkannya ke `1.63+` tanpa upgrade OS karena Playwright 1.63 menghentikan dukungan Ubuntu 20.04.
