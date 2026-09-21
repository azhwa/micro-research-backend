# micro-research-backend

Backend Microstock Research menggunakan Node.js, TypeScript, Fastify, Playwright, Crawlee, Drizzle, dan Turso.

## Browser crawler

Research memakai `PlaywrightCrawler` dengan CloakBrowser sebagai Chromium runtime. Mode default adalah `CRAWLER_BROWSER=cloak`, `PLAYWRIGHT_HEADLESS=true`, dan `CLOAKBROWSER_HUMANIZE=false`. Profile persisten disimpan di `storage/cloak-profile` agar cookie dan cache challenge Adobe dapat dipakai ulang.

`PLAYWRIGHT_CDP_URL` hanya digunakan jika `CRAWLER_BROWSER=cdp` dipilih secara eksplisit. Dengan mode CloakBrowser, backend meluncurkan browser sendiri dan tidak membutuhkan service CDP eksternal.

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

## Backup database ke Cloudflare R2

Backup menggunakan logical SQLite dump yang dikompresi gzip. Setiap backup berhasil diunggah ke dua lokasi:

- `backups/latest/database.sql.gz`: salinan terakhir yang tidak ikut lifecycle penghapusan.
- `backups/archive/YYYY-MM-DD/database-YYYYMMDDHHmmss.sql.gz`: salinan bertimestamp untuk retensi harian/mingguan/bulanan.

Isi `R2_*` dan aktifkan `BACKUP_ENABLED=true` di server. Gunakan token R2 khusus bucket backup, dan jangan beri token aplikasi izin mengubah bucket lock. Service melakukan pengecekan setiap jam, tetapi hanya membuat snapshot baru jika salinan `latest` sudah lebih tua dari `BACKUP_INTERVAL_HOURS`.

Untuk migrasi database utama dari Turso ke SQLite lokal, biarkan `DATABASE_DRIVER=turso`, hentikan proses backend, lalu jalankan:

```bash
npm run db:migrate-local
```

Jika hasil `integrityCheck` adalah `ok`, ubah `DATABASE_DRIVER=local`, lalu build dan restart PM2. File SQLite berada di `LOCAL_DATABASE_PATH` dan wajib berada pada storage persistent.

Untuk backup manual:

```bash
npm run db:backup
```

Restore default ke database testing lokal:

```bash
npm run db:restore
```

Perintah tersebut mengambil `BACKUP_LATEST_KEY` dari R2 dan membuat `storage/restore-test.sqlite`. Database utama tidak akan disentuh. Untuk memulihkan archive tertentu:

```bash
npm run db:restore -- --key backups/archive/2026-09-19/database-20260919102208.sql.gz
```

Jika file testing sudah ada dan memang ingin ditimpa, tambahkan `--replace`. Script selalu menjalankan `PRAGMA integrity_check` dan menampilkan jumlah `research_runs`, `assets`, serta `asset_keywords` setelah restore.

Di Cloudflare R2, buat lifecycle rule hanya untuk prefix `backups/archive/`. Jangan buat lifecycle rule untuk `backups/latest/`. Aktifkan Bucket Lock pada prefix archive sesuai masa retensi yang diinginkan, misalnya 30 hari.
