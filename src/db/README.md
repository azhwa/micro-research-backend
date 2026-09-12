# Database

Database menggunakan Turso/libSQL melalui Drizzle ORM.

Konfigurasi yang digunakan:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

Perintah lokal:

- `npm run db:generate` untuk membuat migration SQL.
- `npm run db:push` untuk menerapkan schema ke database Turso.
