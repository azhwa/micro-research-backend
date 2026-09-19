import { mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { env } from "../config/env";
import * as schema from "./schema";

const localDatabasePath = path.resolve(process.cwd(), env.localDatabasePath);
mkdirSync(path.dirname(localDatabasePath), { recursive: true });

export const localClient = createClient({
  url: `file:${localDatabasePath}`
});

export const isTursoConfigured = Boolean(
  env.tursoDatabaseUrl && env.tursoAuthToken
);

export const tursoClient = isTursoConfigured
  ? createClient({
      url: env.tursoDatabaseUrl,
      authToken: env.tursoAuthToken
    })
  : null;

export const primaryClient = env.databaseDriver === "local" ? localClient : tursoClient;
export const isDatabaseConfigured = Boolean(primaryClient);
export const db = primaryClient ? drizzle(primaryClient, { schema }) : null;

export function getDatabase() {
  if (!db) {
    throw new Error("Database utama belum dikonfigurasi");
  }

  return db;
}

export async function checkDatabase(): Promise<boolean> {
  if (!primaryClient) {
    throw new Error("Database utama belum dikonfigurasi");
  }

  const result = await primaryClient.execute("SELECT 1 AS ok");
  return result.rows[0]?.ok === 1 || result.rows[0]?.ok === "1";
}

export async function initializeLocalDatabase(): Promise<void> {
  const localDatabase = drizzle(localClient, { schema });
  await migrate(localDatabase, {
    migrationsFolder: path.resolve(process.cwd(), "drizzle")
  });
}
