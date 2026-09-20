import { and, asc, eq, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/client";
import { researchQueue } from "../db/schema";
import type { AuthContext } from "../auth";
import { createResearchRun } from "./research.service";

export type ResearchQueueAssetType = "images" | "videos";

export interface CreateResearchQueueInput {
  seedKeyword: string;
  category: string;
  ownerUserId?: string | null;
  organizationId?: string | null;
  assetType: ResearchQueueAssetType;
  locale: string;
}

function normalizeQueueText(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized || fallback;
}

function queueScopeCondition(auth?: AuthContext | null): SQL | undefined {
  if (!auth || auth.isDevBypass) return undefined;
  return auth.organizationId
    ? eq(researchQueue.organizationId, auth.organizationId)
    : eq(researchQueue.ownerUserId, auth.userId);
}

async function findQueueItem(id: string, auth?: AuthContext | null) {
  const database = getDatabase();
  const scope = queueScopeCondition(auth);
  const rows = await database
    .select()
    .from(researchQueue)
    .where(scope ? and(eq(researchQueue.id, id), scope) : eq(researchQueue.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function createResearchQueueItem(input: CreateResearchQueueInput) {
  const database = getDatabase();
  const seedKeyword = normalizeQueueText(input.seedKeyword, "");
  const category = normalizeQueueText(input.category, "general");
  const assetType = input.assetType === "videos" ? "videos" : "images";
  const locale = input.locale.trim() || "en-GB";
  const scope = input.organizationId
    ? eq(researchQueue.organizationId, input.organizationId)
    : input.ownerUserId
      ? eq(researchQueue.ownerUserId, input.ownerUserId)
      : undefined;
  const existingRows = await database
    .select()
    .from(researchQueue)
    .where(scope ? and(scope, eq(researchQueue.status, "queued")) : eq(researchQueue.status, "queued"));
  const existing = existingRows.find((item) =>
    normalizeQueueText(item.seedKeyword, "") === seedKeyword
    && normalizeQueueText(item.category, "general") === category
    && item.assetType === assetType
    && item.locale === locale
  );
  if (existing) return existing;

  const id = `queue_${randomUUID()}`;
  await database.insert(researchQueue).values({
    id,
    seedKeyword,
    category,
    ownerUserId: input.ownerUserId ?? null,
    organizationId: input.organizationId ?? null,
    assetType,
    locale,
    mode: "full",
    maxSuggestions: 1,
    assetsPerQuery: 100,
    autocompleteEnabled: false,
    status: "queued"
  });
  return findQueueItem(id);
}

export async function listResearchQueue(limit = 100, auth?: AuthContext | null) {
  const database = getDatabase();
  const scope = queueScopeCondition(auth);
  return database
    .select()
    .from(researchQueue)
    .where(scope)
    .orderBy(asc(researchQueue.status), asc(researchQueue.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
}

export async function getResearchQueueItem(id: string, auth?: AuthContext | null) {
  return findQueueItem(id, auth);
}

export async function startResearchQueueItem(id: string, auth?: AuthContext | null) {
  const database = getDatabase();
  const item = await getResearchQueueItem(id, auth);
  if (!item) return null;
  if (item.status !== "queued") return { item, run: null };

  await database
    .update(researchQueue)
    .set({ status: "starting", updatedAt: new Date(), errorMessage: null })
    .where(and(eq(researchQueue.id, id), eq(researchQueue.status, "queued")));

  try {
    const run = await createResearchRun({
      keyword: item.seedKeyword,
      category: item.category,
      ownerUserId: item.ownerUserId,
      organizationId: item.organizationId,
      assetType: item.assetType as ResearchQueueAssetType,
      locale: item.locale,
      maxSuggestions: item.maxSuggestions,
      assetsPerQuery: item.assetsPerQuery,
      autocompleteEnabled: item.autocompleteEnabled,
      mode: "full"
    });
    await database
      .update(researchQueue)
      .set({ status: "started", researchRunId: run.id, startedAt: new Date(), updatedAt: new Date() })
      .where(eq(researchQueue.id, id));
    return { item: await getResearchQueueItem(id, auth), run };
  } catch (error) {
    await database
      .update(researchQueue)
      .set({ status: "queued", errorMessage: error instanceof Error ? error.message : "Research tidak dapat dimulai", updatedAt: new Date() })
      .where(eq(researchQueue.id, id));
    throw error;
  }
}

export async function deleteResearchQueueItem(id: string, auth?: AuthContext | null) {
  const item = await getResearchQueueItem(id, auth);
  if (!item) return null;
  await getDatabase().delete(researchQueue).where(eq(researchQueue.id, id));
  return { deleted: true, queueId: id };
}
