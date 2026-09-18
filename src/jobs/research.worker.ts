import { and, asc, eq } from "drizzle-orm";
import { getDatabase, isDatabaseConfigured } from "../db/client";
import { researchJobs, researchRuns } from "../db/schema";
import { runAdobeResearch } from "../crawlers/adobe-stock";
import { appendResearchEvent, getResearchRun } from "../services/research.service";
import { persistResearchSnapshots } from "../services/snapshot.service";
import { env } from "../config/env";

const POLL_INTERVAL_MS = 5_000;
const MAX_ATTEMPTS = 3;
const STALE_JOB_MS = 20 * 60 * 1_000;

class ResearchWorker {
  private activeJobs = new Set<string>();
  private recovering = false;
  private timer: NodeJS.Timeout | undefined;

  start(): void {
    if (!isDatabaseConfigured || this.timer) return;

    this.timer = setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (!isDatabaseConfigured) return;

    const availableSlots = env.workerConcurrency - this.activeJobs.size;
    if (availableSlots <= 0) return;

    const database = getDatabase();

    if (!this.recovering) {
      this.recovering = true;
      try {
        const runningJobs = await database
          .select()
          .from(researchJobs)
          .where(eq(researchJobs.status, "running"))
          .limit(20);
        const staleBefore = Date.now() - STALE_JOB_MS;
        for (const runningJob of runningJobs) {
          if (this.activeJobs.has(runningJob.id)) continue;
          const heartbeat = runningJob.heartbeatAt ?? runningJob.lockedAt;
          if (!heartbeat || heartbeat.getTime() >= staleBefore) continue;
          await database
            .update(researchJobs)
            .set({
              status: "pending",
              lockedAt: null,
              heartbeatAt: null,
              lastError: "Job dikembalikan ke antrean setelah heartbeat timeout",
              updatedAt: new Date()
            })
            .where(eq(researchJobs.id, runningJob.id));
          await database
            .update(researchRuns)
            .set({ status: "pending", errorMessage: "Worker sebelumnya berhenti; research akan dilanjutkan" })
            .where(eq(researchRuns.id, runningJob.researchRunId));
          await appendResearchEvent(
            runningJob.researchRunId,
            "warning",
            "job_recovered",
            "Job dikembalikan ke antrean setelah heartbeat timeout"
          );
        }
      } catch {
        // Retry next cycle
      } finally {
        this.recovering = false;
      }
    }

    try {
      const pending = await database
        .select()
        .from(researchJobs)
        .where(eq(researchJobs.status, "pending"))
        .orderBy(asc(researchJobs.createdAt))
        .limit(availableSlots);

      for (const job of pending) {
        if (this.activeJobs.has(job.id)) continue;
        this.activeJobs.add(job.id);

        void this.processJob(job).finally(() => {
          this.activeJobs.delete(job.id);
        });
      }
    } catch {
      // Retry next cycle
    }
  }

  private async processJob(job: typeof researchJobs.$inferSelect): Promise<void> {
    const database = getDatabase();

    await database
      .update(researchJobs)
      .set({
        status: "running",
        attempts: job.attempts + 1,
        lockedAt: new Date(),
        heartbeatAt: new Date(),
        updatedAt: new Date()
      })
      .where(and(eq(researchJobs.id, job.id), eq(researchJobs.status, "pending")));

    await database
      .update(researchRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(researchRuns.id, job.researchRunId));
    await appendResearchEvent(job.researchRunId, "info", "job_started", "Research job dimulai", {
      attempt: job.attempts + 1
    });

    try {
      await runAdobeResearch(job.researchRunId, {
        onQueryProgress: async (completed) => {
          const now = new Date();
          await database
            .update(researchJobs)
            .set({ lockedAt: now, heartbeatAt: now, updatedAt: now })
            .where(eq(researchJobs.id, job.id));
          await database
            .update(researchRuns)
            .set({ progressCompleted: completed })
            .where(eq(researchRuns.id, job.researchRunId));
        }
      });
      const finishedRun = await getResearchRun(job.researchRunId);

      if (finishedRun?.status === "cancelled") {
        await appendResearchEvent(job.researchRunId, "warning", "job_cancelled", "Research dihentikan");
        await database
          .update(researchJobs)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(eq(researchJobs.id, job.id));
      } else if (
        finishedRun &&
        finishedRun.progressTotal > 0 &&
        finishedRun.progressCompleted < finishedRun.progressTotal
      ) {
        const message = `Crawler berhenti sebelum semua query selesai (${finishedRun.progressCompleted}/${finishedRun.progressTotal})`;
        throw new Error(message);
      } else {
        try {
          const snapshot = await persistResearchSnapshots(job.researchRunId);
          await appendResearchEvent(
            job.researchRunId,
            "success",
            "snapshots_saved",
            `Snapshot scoring tersimpan: ${snapshot.keywords} keyword dan ${snapshot.assets} asset`,
            snapshot
          );
        } catch (snapshotError) {
          const message = snapshotError instanceof Error ? snapshotError.message : "Snapshot gagal disimpan";
          await appendResearchEvent(job.researchRunId, "warning", "snapshots_failed", message);
        }
        await appendResearchEvent(job.researchRunId, "success", "job_completed", "Research selesai diproses");
        await database
          .update(researchRuns)
          .set({ status: "completed", completedAt: new Date() })
          .where(eq(researchRuns.id, job.researchRunId));
        await database
          .update(researchJobs)
          .set({ status: "completed", updatedAt: new Date() })
          .where(eq(researchJobs.id, job.id));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const shouldRetry = job.attempts < MAX_ATTEMPTS;
      if (shouldRetry) {
        await appendResearchEvent(
          job.researchRunId,
          "warning",
          "job_retry_scheduled",
          `Research gagal dan akan dicoba ulang (${job.attempts}/${MAX_ATTEMPTS}): ${message}`,
          { attempt: job.attempts, maxAttempts: MAX_ATTEMPTS }
        );
        await database
          .update(researchRuns)
          .set({ status: "pending", errorMessage: message, completedAt: null })
          .where(eq(researchRuns.id, job.researchRunId));
        await database
          .update(researchJobs)
          .set({ status: "pending", lockedAt: null, heartbeatAt: null, lastError: message, updatedAt: new Date() })
          .where(eq(researchJobs.id, job.id));
      } else {
        const latestRun = await getResearchRun(job.researchRunId);
        const partial = Boolean(
          latestRun && latestRun.progressTotal > 0 && latestRun.progressCompleted < latestRun.progressTotal
        );
        await appendResearchEvent(job.researchRunId, "error", partial ? "job_partial" : "job_failed", `Research gagal: ${message}`);
        await database
          .update(researchRuns)
          .set({ status: partial ? "partial" : "failed", errorMessage: message, completedAt: new Date() })
          .where(eq(researchRuns.id, job.researchRunId));
        await database
          .update(researchJobs)
          .set({ status: "failed", lockedAt: null, heartbeatAt: null, lastError: message, updatedAt: new Date() })
          .where(eq(researchJobs.id, job.id));
      }
    }
  }
}

export const researchWorker = new ResearchWorker();

