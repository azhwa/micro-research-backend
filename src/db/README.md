# Database

Database utama dapat menggunakan SQLite lokal/libSQL melalui Drizzle ORM. Turso tetap dipakai sebagai sumber migrasi dan backup sekunder.

Konfigurasi yang digunakan:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `DATABASE_DRIVER=local|turso`
- `LOCAL_DATABASE_PATH` (default: `storage/micro-research.sqlite`)

Perintah lokal:

- `npm run db:generate` untuk membuat migration SQL.
- `npm run db:push` untuk menerapkan schema ke database Turso.
- `npm run db:migrate-local` untuk menyalin data Turso ke database SQLite lokal yang masih kosong.
