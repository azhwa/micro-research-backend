import { buildApp } from "./app";
import { env } from "./config/env";
import { researchWorker } from "./jobs/research.worker";
import { RETENTION_POLICY, runRetentionCleanup } from "./services/retention.service";
import { isR2BackupConfigured, runDatabaseBackup } from "./services/backup.service";
import { initializeLocalDatabase } from "./db/client";

const RETENTION_INTERVAL_MS = RETENTION_POLICY.intervalHours * 60 * 60 * 1_000;
const BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

async function start(): Promise<void> {
  const app = buildApp();

  try {
    if (env.databaseDriver === "local") await initializeLocalDatabase();
    await app.listen({
      host: env.host,
      port: env.port
    });
    researchWorker.start();
    const cleanup = async () => {
      try {
        const result = await runRetentionCleanup();
        if (!result.skipped) app.log.info({ retention: result }, "Retention cleanup selesai");
      } catch (error) {
        app.log.error({ err: error }, "Retention cleanup gagal");
      }
    };
    void cleanup();
    setInterval(() => void cleanup(), RETENTION_INTERVAL_MS);

    if (env.backupEnabled && isR2BackupConfigured) {
      let backupRunning = false;
      const backup = async () => {
        if (backupRunning) return;
        backupRunning = true;
        try {
          const result = await runDatabaseBackup();
          if (!result.skipped) app.log.info({ backup: result }, "Database backup R2 selesai");
        } catch (error) {
          app.log.error({ err: error }, "Database backup R2 gagal");
        } finally {
          backupRunning = false;
        }
      };
      void backup();
      setInterval(() => void backup(), BACKUP_CHECK_INTERVAL_MS);
    } else if (env.backupEnabled) {
      app.log.warn("BACKUP_ENABLED aktif tetapi konfigurasi R2 belum lengkap");
    }
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();
