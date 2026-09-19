import { getDatabase, isDatabaseConfigured } from "../db/client";
import {
  claimPendingSeedDiscoveryJob,
  processSeedDiscoveryJob
} from "../services/seed-discovery.service";

const POLL_INTERVAL_MS = 5_000;

class SeedDiscoveryWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  start(): void {
    if (!isDatabaseConfigured || this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (!isDatabaseConfigured || this.running) return;
    this.running = true;
    try {
      const job = await claimPendingSeedDiscoveryJob();
      if (job) await processSeedDiscoveryJob(job.id);
    } catch {
      // The next poll retries a job that remains pending.
    } finally {
      this.running = false;
    }
  }
}

export const seedDiscoveryWorker = new SeedDiscoveryWorker();
