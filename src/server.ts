import { buildApp } from "./app";
import { env } from "./config/env";
import { researchWorker } from "./jobs/research.worker";
import { RETENTION_POLICY, runRetentionCleanup } from "./services/retention.service";

const RETENTION_INTERVAL_MS = RETENTION_POLICY.intervalHours * 60 * 60 * 1_000;

async function start(): Promise<void> {
  const app = buildApp();

  try {
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
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();
