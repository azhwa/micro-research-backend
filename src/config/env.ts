import dotenv from "dotenv";

dotenv.config();

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 3000);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT harus berupa angka antara 1 dan 65535");
  }

  return port;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parsePositiveInteger(value: string | undefined, fallback: number, max = 10): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parsePort(process.env.PORT),
  host: process.env.HOST ?? "127.0.0.1",
  playwrightHeadless: parseBoolean(process.env.PLAYWRIGHT_HEADLESS, true),
  playwrightCdpUrl: process.env.PLAYWRIGHT_CDP_URL?.trim() ?? "",
  playwrightCdpConnectTimeoutMs: parsePositiveInteger(process.env.PLAYWRIGHT_CDP_CONNECT_TIMEOUT_MS, 30_000, 120_000),
  researchTimeoutMs: parsePositiveInteger(process.env.RESEARCH_TIMEOUT_MINUTES, 45, 180) * 60_000,
  workerConcurrency: parsePositiveInteger(process.env.WORKER_CONCURRENCY, 1, 10),
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
  tursoDatabaseUrl: process.env.TURSO_DATABASE_URL ?? "",
  tursoAuthToken: process.env.TURSO_AUTH_TOKEN ?? "",
  authUsername: process.env.AUTH_USERNAME ?? "",
  authUserId: process.env.AUTH_USER_ID ?? "local-user",
  authPasswordHash: process.env.AUTH_PASSWORD_HASH ?? "",
  authSessionSecret: process.env.AUTH_SESSION_SECRET ?? "",
  authSessionTtlHours: parsePositiveInteger(process.env.AUTH_SESSION_TTL_HOURS, 168, 24 * 365),
  geminiEncryptionKey: process.env.GEMINI_ENCRYPTION_KEY ?? "",
  r2Endpoint: process.env.R2_ENDPOINT?.trim() ?? "",
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID?.trim() ?? "",
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim() ?? "",
  r2Bucket: process.env.R2_BUCKET?.trim() ?? "",
  backupEnabled: parseBoolean(process.env.BACKUP_ENABLED, false),
  backupIntervalHours: parsePositiveInteger(process.env.BACKUP_INTERVAL_HOURS, 24, 24 * 31),
  backupBatchSize: parsePositiveInteger(process.env.BACKUP_BATCH_SIZE, 500, 5_000),
  backupLatestKey: process.env.BACKUP_LATEST_KEY?.trim() || "backups/latest/database.sql.gz",
  backupArchivePrefix: process.env.BACKUP_ARCHIVE_PREFIX?.trim() || "backups/archive"
} as const;

export const authConfigured = Boolean(
  env.authUsername && env.authPasswordHash && env.authSessionSecret
);

if (env.nodeEnv === "production" && !authConfigured) {
  throw new Error(
    "Production membutuhkan AUTH_USERNAME, AUTH_PASSWORD_HASH, dan AUTH_SESSION_SECRET"
  );
}
