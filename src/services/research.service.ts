import { createHash, randomUUID } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import {
  assetObservations,
  assetKeywords,
  assetOpportunitySnapshots,
  assets,
  aiRecommendations,
  keywordOpportunitySnapshots,
  researchJobs,
  researchRuns,
  researchEvents,
  searchQueries,
  suggestions
} from "../db/schema";
import { getDatabase } from "../db/client";
import type { AuthContext } from "../auth";

export type AssetType = "images" | "videos";

export interface CreateResearchInput {
  keyword: string;
  category: string;
  ownerClerkUserId?: string | null;
  organizationId?: string | null;
  assetType: AssetType;
  locale: string;
  maxSuggestions: number;
  assetsPerQuery: number;
}

function stableId(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\u001f"))
    .digest("hex")
    .slice(0, 32);
}

export async function createResearchRun(input: CreateResearchInput) {
  const database = getDatabase();
  const runId = `run_${randomUUID()}`;
  const jobId = `job_${randomUUID()}`;

  await database.insert(researchRuns).values({
    id: runId,
    seedKeyword: input.keyword,
    category: input.category,
    ownerClerkUserId: input.ownerClerkUserId ?? null,
    organizationId: input.organizationId ?? null,
    assetType: input.assetType,
    locale: input.locale,
    maxSuggestions: input.maxSuggestions,
    assetsPerQuery: input.assetsPerQuery,
    status: "pending"
  });

  await database.insert(researchJobs).values({
    id: jobId,
    researchRunId: runId,
    status: "pending"
  });

  return { id: runId, jobId, status: "pending" as const };
}

export async function listResearchRuns(limit = 20, auth?: AuthContext | null) {
  const database = getDatabase();
  void auth;
  return database
    .select()
    .from(researchRuns)
    .orderBy(desc(researchRuns.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
}

export async function getResearchRun(id: string, auth?: AuthContext | null) {
  const database = getDatabase();
  void auth;
  const rows = await database
    .select()
    .from(researchRuns)
    .where(eq(researchRuns.id, id))
    .limit(1);

  return rows[0] ?? null;
}

export async function cancelResearchRun(id: string, auth?: AuthContext | null) {
  const database = getDatabase();
  const run = await getResearchRun(id, auth);

  if (!run || ["completed", "failed", "cancelled"].includes(run.status)) {
    return null;
  }

  await database
    .update(researchRuns)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(eq(researchRuns.id, id));

  await database
    .update(researchJobs)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(researchJobs.researchRunId, id));

  await appendResearchEvent(id, "warning", "run_cancelled", "Research dibatalkan oleh user");

  return getResearchRun(id);
}

export async function deleteResearchRun(id: string, auth?: AuthContext | null) {
  const database = getDatabase();
  const run = await getResearchRun(id, auth);
  if (!run) return null;

  if (["pending", "running"].includes(run.status)) {
    const error = new Error("RESEARCH_ACTIVE");
    error.name = "RESEARCH_ACTIVE";
    throw error;
  }

  const relatedAssetRows = await Promise.all([
    database.select({ assetId: assetObservations.assetId }).from(assetObservations).where(eq(assetObservations.researchRunId, id)),
    database.select({ assetId: assetKeywords.assetId }).from(assetKeywords).where(eq(assetKeywords.researchRunId, id)),
    database.select({ assetId: assetOpportunitySnapshots.assetId }).from(assetOpportunitySnapshots).where(eq(assetOpportunitySnapshots.researchRunId, id))
  ]);
  const assetIds = new Set(relatedAssetRows.flat().map((row) => row.assetId));

  // Delete run-scoped rows explicitly so cleanup does not depend only on SQLite FK settings.
  await database.delete(assetObservations).where(eq(assetObservations.researchRunId, id));
  await database.delete(assetKeywords).where(eq(assetKeywords.researchRunId, id));
  await database.delete(assetOpportunitySnapshots).where(eq(assetOpportunitySnapshots.researchRunId, id));
  await database.delete(keywordOpportunitySnapshots).where(eq(keywordOpportunitySnapshots.researchRunId, id));
  await database.delete(researchEvents).where(eq(researchEvents.researchRunId, id));
  await database.delete(suggestions).where(eq(suggestions.researchRunId, id));
  await database.delete(searchQueries).where(eq(searchQueries.researchRunId, id));
  await database.delete(aiRecommendations).where(eq(aiRecommendations.researchRunId, id));
  await database.delete(researchJobs).where(eq(researchJobs.researchRunId, id));
  await database.delete(researchRuns).where(eq(researchRuns.id, id));

  // Assets are shared across runs. Remove only assets that no longer have any reference.
  let orphanedAssets = 0;
  for (const assetId of assetIds) {
    const [observationRefs, keywordRefs, snapshotRefs] = await Promise.all([
      database.select({ id: assetObservations.id }).from(assetObservations).where(eq(assetObservations.assetId, assetId)).limit(1),
      database.select({ id: assetKeywords.id }).from(assetKeywords).where(eq(assetKeywords.assetId, assetId)).limit(1),
      database.select({ id: assetOpportunitySnapshots.id }).from(assetOpportunitySnapshots).where(eq(assetOpportunitySnapshots.assetId, assetId)).limit(1)
    ]);
    if (!observationRefs.length && !keywordRefs.length && !snapshotRefs.length) {
      const deleted = await database.delete(assets).where(eq(assets.id, assetId)).returning({ id: assets.id });
      orphanedAssets += deleted.length;
    }
  }

  return { deleted: true, researchRunId: id, orphanedAssets };
}

export type ResearchEventLevel = "info" | "success" | "warning" | "error";

export async function appendResearchEvent(
  researchRunId: string,
  level: ResearchEventLevel,
  eventType: string,
  message: string,
  metadata?: Record<string, unknown>
) {
  try {
    await getDatabase().insert(researchEvents).values({
      id: `event_${randomUUID()}`,
      researchRunId,
      level,
      eventType,
      message,
      metadataJson: metadata ? JSON.stringify(metadata) : null
    });
  } catch {
    // Event logging must never fail the research job.
  }
}

export async function listResearchEvents(researchRunId: string, limit = 100) {
  return getDatabase()
    .select()
    .from(researchEvents)
    .where(eq(researchEvents.researchRunId, researchRunId))
    .orderBy(desc(researchEvents.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

export async function getResearchResults(
  researchRunId: string,
  limit = 50,
  offset = 0
) {
  const database = getDatabase();

  return database
    .select({
      observationId: assetObservations.id,
      assetId: assets.id,
      externalId: assets.externalId,
      assetType: assets.assetType,
      title: assets.title,
      assetUrl: assets.assetUrl,
      thumbnailUrl: assets.thumbnailUrl,
      width: assets.width,
      height: assets.height,
      isPremium: assets.isPremium,
      query: searchQueries.query,
      sortMode: assetObservations.sortMode,
      rank: assetObservations.rank,
      observedAt: assetObservations.observedAt
    })
    .from(assetObservations)
    .innerJoin(assets, eq(assetObservations.assetId, assets.id))
    .innerJoin(
      searchQueries,
      eq(assetObservations.searchQueryId, searchQueries.id)
    )
    .where(eq(assetObservations.researchRunId, researchRunId))
    .orderBy(asc(assetObservations.sortMode), asc(assetObservations.rank))
    .limit(Math.min(Math.max(limit, 1), 1000))
    .offset(Math.max(offset, 0));
}

export async function getResearchKeywords(
  researchRunId: string,
  limit = 500,
  offset = 0
) {
  const database = getDatabase();

  return database
    .select({
      id: assetKeywords.id,
      assetId: assets.id,
      externalId: assets.externalId,
      title: assets.title,
      keyword: assetKeywords.keyword,
      normalizedKeyword: assetKeywords.normalizedKeyword,
      source: assetKeywords.source,
      position: assetKeywords.position,
      observedAt: assetKeywords.observedAt
    })
    .from(assetKeywords)
    .innerJoin(assets, eq(assetKeywords.assetId, assets.id))
    .where(eq(assetKeywords.researchRunId, researchRunId))
    .orderBy(asc(assetKeywords.position), asc(assetKeywords.keyword))
    .limit(Math.min(Math.max(limit, 1), 1000))
    .offset(Math.max(offset, 0));
}

export function makeStableId(...parts: string[]): string {
  return stableId(...parts);
}
