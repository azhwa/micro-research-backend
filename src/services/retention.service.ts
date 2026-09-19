import { and, eq, inArray, lt } from "drizzle-orm";
import {
  assetKeywords,
  assetObservations,
  assetOpportunitySnapshots,
  assets,
  researchEvents,
  researchRuns,
  searchQueries,
  suggestions
} from "../db/schema";
import { getDatabase, isDatabaseConfigured } from "../db/client";
import { deleteResearchRun } from "./research.service";
import { pruneResearchDetailLogs } from "./research-log.service";
import { invalidateGlobalInsightsCache } from "./snapshot.service";

export const RETENTION_POLICY = {
  rawDataDays: 30,
  snapshotDays: 90,
  eventDays: 14,
  intervalHours: 6
} as const;

const TERMINAL_STATUSES = ["completed", "partial", "failed", "cancelled"];
let cleanupRunning = false;

function cutoffDate(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

async function pruneRawData(database: ReturnType<typeof getDatabase>, before: Date) {
  const runs = await database
    .select({ id: researchRuns.id })
    .from(researchRuns)
    .where(and(inArray(researchRuns.status, TERMINAL_STATUSES), lt(researchRuns.createdAt, before)));

  let runsProcessed = 0;
  let observationsDeleted = 0;
  let keywordsDeleted = 0;
  let queriesDeleted = 0;
  let suggestionsDeleted = 0;
  let assetsDeleted = 0;

  for (const run of runs) {
    const [observationRows, keywordRows] = await Promise.all([
      database.select({ assetId: assetObservations.assetId }).from(assetObservations).where(eq(assetObservations.researchRunId, run.id)),
      database.select({ assetId: assetKeywords.assetId }).from(assetKeywords).where(eq(assetKeywords.researchRunId, run.id))
    ]);
    const assetIds = new Set([...observationRows, ...keywordRows].map((row) => row.assetId));

    observationsDeleted += (await database.delete(assetObservations).where(eq(assetObservations.researchRunId, run.id))).rowsAffected ?? 0;
    keywordsDeleted += (await database.delete(assetKeywords).where(eq(assetKeywords.researchRunId, run.id))).rowsAffected ?? 0;
    queriesDeleted += (await database.delete(searchQueries).where(eq(searchQueries.researchRunId, run.id))).rowsAffected ?? 0;
    suggestionsDeleted += (await database.delete(suggestions).where(eq(suggestions.researchRunId, run.id))).rowsAffected ?? 0;
    runsProcessed += 1;

    // Assets are shared between runs. Only remove an asset after every raw
    // reference and every retained snapshot has disappeared.
    for (const assetId of assetIds) {
      const [observationRef, keywordRef, snapshotRef] = await Promise.all([
        database.select({ id: assetObservations.id }).from(assetObservations).where(eq(assetObservations.assetId, assetId)).limit(1),
        database.select({ id: assetKeywords.id }).from(assetKeywords).where(eq(assetKeywords.assetId, assetId)).limit(1),
        database.select({ id: assetOpportunitySnapshots.id }).from(assetOpportunitySnapshots).where(eq(assetOpportunitySnapshots.assetId, assetId)).limit(1)
      ]);
      if (!observationRef.length && !keywordRef.length && !snapshotRef.length) {
        assetsDeleted += (await database.delete(assets).where(eq(assets.id, assetId))).rowsAffected ?? 0;
      }
    }
  }

  return { runsProcessed, observationsDeleted, keywordsDeleted, queriesDeleted, suggestionsDeleted, assetsDeleted };
}

export async function runRetentionCleanup() {
  if (!isDatabaseConfigured || cleanupRunning) {
    return { skipped: true } as const;
  }

  cleanupRunning = true;
  try {
    const database = getDatabase();
    const deletedEvents = (await database.delete(researchEvents).where(lt(researchEvents.createdAt, cutoffDate(RETENTION_POLICY.eventDays)))).rowsAffected ?? 0;
    const deletedDetailLogs = await pruneResearchDetailLogs(cutoffDate(RETENTION_POLICY.rawDataDays));
    const raw = await pruneRawData(database, cutoffDate(RETENTION_POLICY.rawDataDays));

    const oldRuns = await database
      .select({ id: researchRuns.id })
      .from(researchRuns)
      .where(and(inArray(researchRuns.status, TERMINAL_STATUSES), lt(researchRuns.createdAt, cutoffDate(RETENTION_POLICY.snapshotDays))));
    let deletedRuns = 0;
    let orphanedAssets = 0;
    for (const run of oldRuns) {
      const result = await deleteResearchRun(run.id);
      if (result) {
        deletedRuns += 1;
        orphanedAssets += result.orphanedAssets;
      }
    }
    if (deletedRuns > 0) await invalidateGlobalInsightsCache();

    return {
      skipped: false,
      deletedEvents,
      deletedDetailLogs,
      ...raw,
      deletedRuns,
      orphanedAssets
    } as const;
  } finally {
    cleanupRunning = false;
  }
}
