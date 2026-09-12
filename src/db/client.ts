import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { env } from "../config/env";
import * as schema from "./schema";

export const isDatabaseConfigured = Boolean(
  env.tursoDatabaseUrl && env.tursoAuthToken
);

export const tursoClient = isDatabaseConfigured
  ? createClient({
      url: env.tursoDatabaseUrl,
      authToken: env.tursoAuthToken
    })
  : null;

export const db = tursoClient ? drizzle(tursoClient, { schema }) : null;

export function getDatabase() {
  if (!db) {
    throw new Error("Turso belum dikonfigurasi");
  }

  return db;
}

export async function checkDatabase(): Promise<boolean> {
  if (!tursoClient) {
    throw new Error("Turso belum dikonfigurasi");
  }

  const result = await tursoClient.execute("SELECT 1 AS ok");
  return result.rows[0]?.ok === 1 || result.rows[0]?.ok === "1";
}
