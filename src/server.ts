import { buildApp } from "./app";
import { env } from "./config/env";
import { researchWorker } from "./jobs/research.worker";

async function start(): Promise<void> {
  const app = buildApp();

  try {
    await app.listen({
      host: env.host,
      port: env.port
    });
    researchWorker.start();
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();
