import { desc } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { researchEvents, researchJobs, researchRuns } from "../db/schema";
import { env } from "../config/env";

export async function getMonitoringSnapshot() {
  const database = getDatabase();
  const [runs, jobs, events] = await Promise.all([
    database.select().from(researchRuns).orderBy(desc(researchRuns.createdAt)).limit(500),
    database.select().from(researchJobs).orderBy(desc(researchJobs.updatedAt)).limit(500),
    database.select({ eventType: researchEvents.eventType, level: researchEvents.level, metadataJson: researchEvents.metadataJson, createdAt: researchEvents.createdAt })
      .from(researchEvents).orderBy(desc(researchEvents.createdAt)).limit(2_000)
  ]);

  const countBy = (values: string[]) => values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
  const completed = runs.filter((run) => run.status === "completed" && run.startedAt && run.completedAt);
  const durations = completed.map((run) => run.completedAt!.getTime() - run.startedAt!.getTime());
  const eventCounts = countBy(events.map((event) => event.eventType));
  const levelCounts = countBy(events.map((event) => event.level));
  const enrichment = events
    .filter((event) => event.eventType === "keyword_enrichment_finished")
    .map((event) => {
      try { return JSON.parse(event.metadataJson ?? "{}"); } catch { return {}; }
    })
    .reduce((result, metadata) => ({
      success: result.success + Number(metadata.success ?? 0),
      empty: result.empty + Number(metadata.empty ?? 0),
      failed: result.failed + Number(metadata.failed ?? 0)
    }), { success: 0, empty: 0, failed: 0 });
  const runningJobs = jobs.filter((job) => job.status === "running");
  const heartbeats = runningJobs.map((job) => job.heartbeatAt ?? job.lockedAt).filter((date): date is Date => Boolean(date));

  return {
    generatedAt: new Date().toISOString(),
    worker: {
      concurrency: env.workerConcurrency,
      activeJobs: runningJobs.length,
      lastHeartbeatAt: heartbeats.length ? new Date(Math.max(...heartbeats.map((date) => date.getTime()))).toISOString() : null,
      staleThresholdMinutes: 20,
      maxAttempts: 3
    },
    runs: {
      sampled: runs.length,
      byStatus: countBy(runs.map((run) => run.status)),
      averageDurationSeconds: durations.length ? Math.round((durations.reduce((sum, value) => sum + value, 0) / durations.length) / 100) / 10 : null
    },
    events: { sampled: events.length, byType: eventCounts, byLevel: levelCounts },
    scraper: {
      retries: eventCounts.query_retry ?? 0,
      recoveredJobs: eventCounts.job_recovered ?? 0,
      partialRuns: eventCounts.job_partial ?? 0,
      keywordEnrichment: {
        success: enrichment.success,
        empty: enrichment.empty,
        failed: enrichment.failed
      }
    }
  };
}
