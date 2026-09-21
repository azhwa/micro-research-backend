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

function parseDatabaseDriver(value: string | undefined): "local" | "turso" {
  const driver = value?.trim().toLowerCase() ?? "turso";
  if (driver !== "local" && driver !== "turso") {
    throw new Error("DATABASE_DRIVER harus bernilai local atau turso");
  }
  return driver;
}

function parseCrawlerBrowser(value: string | undefined): "cloak" | "playwright" | "cdp" {
  const browser = value?.trim().toLowerCase() ?? "cloak";
  if (browser !== "cloak" && browser !== "playwright" && browser !== "cdp") {
    throw new Error("CRAWLER_BROWSER harus bernilai cloak, playwright, atau cdp");
  }
  return browser;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parsePort(process.env.PORT),
  host: process.env.HOST ?? "127.0.0.1",
  crawlerBrowser: parseCrawlerBrowser(process.env.CRAWLER_BROWSER),
  playwrightHeadless: parseBoolean(process.env.PLAYWRIGHT_HEADLESS, true),
  cloakBrowserProfileDir: process.env.CLOAKBROWSER_PROFILE_DIR?.trim() || "storage/cloak-profile",
  cloakBrowserHumanize: parseBoolean(process.env.CLOAKBROWSER_HUMANIZE, false),
  cloakBrowserLocale: process.env.CLOAKBROWSER_LOCALE?.trim() || "en-US",
  cloakBrowserTimezone: process.env.CLOAKBROWSER_TIMEZONE?.trim() || "",
  playwrightCdpUrl: process.env.PLAYWRIGHT_CDP_URL?.trim() ?? "",
  playwrightCdpConnectTimeoutMs: parsePositiveInteger(process.env.PLAYWRIGHT_CDP_CONNECT_TIMEOUT_MS, 30_000, 120_000),
  playwrightCdpRetryCount: parsePositiveInteger(process.env.PLAYWRIGHT_CDP_RETRY_COUNT, 5, 10),
  playwrightCdpRetryDelayMs: parsePositiveInteger(process.env.PLAYWRIGHT_CDP_RETRY_DELAY_MS, 5_000, 30_000),
  researchTimeoutMs: parsePositiveInteger(process.env.RESEARCH_TIMEOUT_MINUTES, 45, 180) * 60_000,
  workerConcurrency: parsePositiveInteger(process.env.WORKER_CONCURRENCY, 1, 10),
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
  databaseDriver: parseDatabaseDriver(process.env.DATABASE_DRIVER),
  localDatabasePath: process.env.LOCAL_DATABASE_PATH?.trim() || "storage/micro-research.sqlite",
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
