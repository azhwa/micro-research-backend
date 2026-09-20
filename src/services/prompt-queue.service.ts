import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/client";
import { promptQueueItems } from "../db/schema";
import type { AuthContext } from "../auth";
import { generatePromptSet } from "./prompt-generation.service";

export type PromptQueueStatus = "queued" | "generating" | "completed" | "failed" | "cancelled";

export interface PromptQueueInput {
  keyword: string;
  category?: string;
  researchAssetType?: "images" | "videos";
  promptOutputType?: "image" | "video";
  locale?: string;
  promptCount?: number;
  recommendedStyle?: string;
  styleRationale?: string;
  sourceReadoutId?: string;
  sourceScore?: number;
  sourceLevel?: number;
  sourceConfidence?: "low" | "medium" | "high";
  sourceEvidence?: string[];
  sourceObservedAt?: string;
  ownerUserId?: string | null;
  organizationId?: string | null;
}

function scopeCondition(auth?: AuthContext | null): SQL | undefined {
  if (!auth || auth.isDevBypass) return undefined;
  return auth.organizationId
    ? eq(promptQueueItems.organizationId, auth.organizationId)
    : eq(promptQueueItems.ownerUserId, auth.userId);
}

function normalized(value: string) {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]+/gu, "").replace(/\s+/g, " ").slice(0, 160);
}

function safeCount(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? Math.min(Math.max(value, 1), 20) : 5;
}

function safeText(value: unknown, fallback: string, max = 240) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function parseJsonArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function findItem(id: string, auth?: AuthContext | null) {
  const scope = scopeCondition(auth);
  const rows = await getDatabase().select().from(promptQueueItems)
    .where(scope ? and(eq(promptQueueItems.id, id), scope) : eq(promptQueueItems.id, id))
    .limit(1);
  return rows[0] ?? null;
}

function publicItem(row: typeof promptQueueItems.$inferSelect) {
  return {
    id: row.id,
    keyword: row.keyword,
    category: row.category,
    researchAssetType: row.researchAssetType,
    promptOutputType: row.promptOutputType,
    locale: row.locale,
    promptCount: row.promptCount,
    recommendedStyle: row.recommendedStyle,
    styleRationale: row.styleRationale,
    sourceScore: row.sourceScore,
    sourceLevel: row.sourceLevel,
    sourceConfidence: row.sourceConfidence,
    sourceEvidence: parseJsonArray(row.sourceEvidenceJson),
    sourceObservedAt: row.sourceObservedAt,
    status: row.status as PromptQueueStatus,
    sourceReadoutId: row.sourceReadoutId,
    generationId: row.generationId,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    updatedAt: row.updatedAt
  };
}

export async function createPromptQueueItems(inputs: PromptQueueInput[], auth: AuthContext) {
  const database = getDatabase();
  const rejected: Array<{ keyword: string; reason: string }> = [];
  if (inputs.length > 20) {
    rejected.push(...inputs.slice(20).map((input) => ({ keyword: safeText(input.keyword, "", 160), reason: "MAX_BATCH_20" })));
  }
  const unique = new Map<string, PromptQueueInput>();
  for (const input of inputs.slice(0, 20)) {
    const keyword = safeText(input.keyword, "", 160);
    const key = normalized(keyword);
    if (!key) {
      rejected.push({ keyword, reason: "EMPTY_KEYWORD" });
    } else if (!unique.has(key)) {
      unique.set(key, { ...input, keyword });
    } else {
      rejected.push({ keyword, reason: "DUPLICATE_IN_REQUEST" });
    }
  }
  if (!unique.size) return { created: [], duplicate: [], rejected, skipped: rejected.length };

  const keys = [...unique.keys()];
  const scope = scopeCondition(auth);
  const existing = await database.select().from(promptQueueItems).where(
    scope
      ? and(scope, inArray(promptQueueItems.normalizedKeyword, keys), inArray(promptQueueItems.status, ["queued", "generating", "completed"]))
      : and(inArray(promptQueueItems.normalizedKeyword, keys), inArray(promptQueueItems.status, ["queued", "generating", "completed"]))
  );
  const existingKeys = new Set(existing.map((item) => item.normalizedKeyword));
  const duplicate = [...unique.values()].filter((input) => existingKeys.has(normalized(input.keyword))).map((input) => input.keyword);
  const created = [];
  for (const input of unique.values()) {
    const key = normalized(input.keyword);
    if (existingKeys.has(key)) continue;
    const researchAssetType = input.researchAssetType === "videos" ? "videos" : "images";
    const parsedObservedAt = input.sourceObservedAt ? new Date(input.sourceObservedAt) : null;
    const item = {
      id: `prompt_queue_${randomUUID()}`,
      ownerUserId: auth.isDevBypass ? null : auth.userId,
      organizationId: auth.isDevBypass ? null : auth.organizationId,
      sourceReadoutId: input.sourceReadoutId ?? null,
      sourceScore: typeof input.sourceScore === "number" ? input.sourceScore : null,
      sourceLevel: typeof input.sourceLevel === "number" ? input.sourceLevel : null,
      sourceConfidence: input.sourceConfidence ?? null,
      sourceEvidenceJson: JSON.stringify(Array.isArray(input.sourceEvidence) ? input.sourceEvidence.slice(0, 12) : []),
      sourceObservedAt: parsedObservedAt && !Number.isNaN(parsedObservedAt.getTime()) ? parsedObservedAt : null,
      keyword: input.keyword,
      normalizedKeyword: key,
      category: safeText(input.category, "general", 40),
      researchAssetType,
      promptOutputType: input.promptOutputType === "video" || researchAssetType === "videos" ? "video" : "image",
      locale: safeText(input.locale, "en-GB", 20),
      promptCount: safeCount(input.promptCount),
      recommendedStyle: safeText(input.recommendedStyle, researchAssetType === "videos" ? "commercial stock video" : "commercial stock photography", 160),
      styleRationale: safeText(input.styleRationale, "Style dipilih dari konteks keyword readout.", 500),
      status: "queued",
      errorMessage: null
    } as const;
    await database.insert(promptQueueItems).values(item);
    const row = await findItem(item.id, auth);
    if (row) created.push(publicItem(row));
  }
  return { created, duplicate, rejected, skipped: duplicate.length + rejected.length };
}

export async function listPromptQueue(limit = 100, auth?: AuthContext | null) {
  const scope = scopeCondition(auth);
  const rows = await getDatabase().select().from(promptQueueItems)
    .where(scope)
    .orderBy(asc(promptQueueItems.status), desc(promptQueueItems.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map(publicItem);
}

export async function updatePromptQueueItem(id: string, patch: { promptCount?: number; promptOutputType?: "image" | "video"; recommendedStyle?: string }, auth?: AuthContext | null) {
  const item = await findItem(id, auth);
  if (!item || item.status === "generating") return null;
  const values: Partial<typeof promptQueueItems.$inferInsert> = { updatedAt: new Date() };
  if (patch.promptCount !== undefined) values.promptCount = safeCount(patch.promptCount);
  if (patch.promptOutputType) values.promptOutputType = patch.promptOutputType;
  if (patch.recommendedStyle) values.recommendedStyle = safeText(patch.recommendedStyle, item.recommendedStyle, 160);
  const [updated] = await getDatabase().update(promptQueueItems).set(values).where(eq(promptQueueItems.id, id)).returning();
  return updated ? publicItem(updated) : null;
}

export async function deletePromptQueueItem(id: string, auth?: AuthContext | null) {
  const item = await findItem(id, auth);
  if (!item) return null;
  await getDatabase().delete(promptQueueItems).where(eq(promptQueueItems.id, id));
  return { deleted: true, queueId: id };
}

export async function cancelPromptQueueItem(id: string, auth?: AuthContext | null) {
  const item = await findItem(id, auth);
  if (!item || item.status === "generating" || item.status === "completed" || item.status === "cancelled") return item ? publicItem(item) : null;
  const [updated] = await getDatabase().update(promptQueueItems).set({ status: "cancelled", updatedAt: new Date() }).where(eq(promptQueueItems.id, id)).returning();
  return updated ? publicItem(updated) : null;
}

export async function generatePromptQueueItem(id: string, auth: AuthContext, options: { confirmLowConfidence?: boolean } = {}) {
  const database = getDatabase();
  const item = await findItem(id, auth);
  if (!item) return null;
  if (item.status === "generating") return { item: publicItem(item), result: null };
  if (item.sourceConfidence === "low" && !options.confirmLowConfidence) throw new Error("LOW_CONFIDENCE_CONFIRMATION_REQUIRED");
  await database.update(promptQueueItems).set({ status: "generating", startedAt: new Date(), errorMessage: null, updatedAt: new Date() }).where(eq(promptQueueItems.id, id));
  try {
    const result = await generatePromptSet(auth.userId, auth, {
      seed: item.keyword,
      category: item.category,
      assetType: item.researchAssetType,
      locale: item.locale,
      count: item.promptCount,
      style: item.recommendedStyle
    });
    if (!result) throw new Error("PROMPT_CONTEXT_EMPTY");
    const [updated] = await database.update(promptQueueItems).set({
      status: "completed",
      generationId: result?.generation.id ?? null,
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(promptQueueItems.id, id)).returning();
    return { item: updated ? publicItem(updated) : null, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Prompt generation gagal";
    await database.update(promptQueueItems).set({ status: "failed", errorMessage: message.slice(0, 1_000), updatedAt: new Date() }).where(eq(promptQueueItems.id, id));
    throw error;
  }
}
