import { and, count, desc, eq, inArray, max, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/client";
import { aiRecommendations, savedPrompts } from "../db/schema";
import type { AuthContext } from "../auth";

export interface SavePromptInput {
  generationId: string;
  ownerUserId?: string | null;
  organizationId?: string | null;
  seed: string;
  category: string;
  assetType: string;
  locale: string;
  title: string;
  prompt: string;
  negativePrompt: string;
  keywordFocus: string[];
  commercialRationale: string;
  confidence: string;
}

function scopeCondition(auth?: AuthContext | null): SQL | undefined {
  if (!auth || auth.isDevBypass) return undefined;
  return auth.organizationId
    ? eq(savedPrompts.organizationId, auth.organizationId)
    : eq(savedPrompts.ownerUserId, auth.userId);
}

function parseKeywordFocus(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function publicSavedPrompt(row: typeof savedPrompts.$inferSelect) {
  return {
    id: row.id,
    generationId: row.generationId,
    seed: row.seed,
    category: row.category,
    assetType: row.assetType,
    locale: row.locale,
    title: row.title,
    prompt: row.prompt,
    negativePrompt: row.negativePrompt,
    keywordFocus: parseKeywordFocus(row.keywordFocusJson),
    commercialRationale: row.commercialRationale,
    confidence: row.confidence,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export interface PublicPromptGenerationSet {
  id: string;
  title: string;
  seed: string;
  category: string;
  assetType: string;
  locale: string;
  style: string;
  createdAt: Date;
  promptCount: number;
  prompts: ReturnType<typeof publicSavedPrompt>[];
}

const LIBRARY_PAGE_SIZE = 50;

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const timestamp = typeof value === "number" ? value : Number(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
}

export async function saveGeneratedPrompts(input: SavePromptInput[]): Promise<void> {
  if (!input.length) return;
  const database = getDatabase();
  const generationId = input[0].generationId;
  const existing = await database
    .select({ id: savedPrompts.id })
    .from(savedPrompts)
    .where(eq(savedPrompts.generationId, generationId));
  if (existing.length) return;

  await database.insert(savedPrompts).values(input.map((item) => ({
    id: `saved_prompt_${randomUUID()}`,
    generationId: item.generationId,
    ownerUserId: item.ownerUserId ?? null,
    organizationId: item.organizationId ?? null,
    seed: item.seed,
    category: item.category,
    assetType: item.assetType,
    locale: item.locale,
    title: item.title,
    prompt: item.prompt,
    negativePrompt: item.negativePrompt,
    keywordFocusJson: JSON.stringify(item.keywordFocus),
    commercialRationale: item.commercialRationale,
    confidence: item.confidence,
    status: "saved"
  })));
}

export async function listSavedPrompts(limit = 100, auth?: AuthContext | null) {
  const database = getDatabase();
  const scope = scopeCondition(auth);
  const rows = await database
    .select()
    .from(savedPrompts)
    .where(scope)
    .orderBy(desc(savedPrompts.createdAt))
    .limit(Math.min(Math.max(limit, 1), 1_000));
  return rows.map(publicSavedPrompt);
}

export async function listPromptGenerationSets(limit = 100, auth?: AuthContext | null): Promise<PublicPromptGenerationSet[]> {
  return listPromptGenerationSetMetadata(limit, auth);
}

async function listPromptGenerationSetMetadata(limit = 100, auth?: AuthContext | null): Promise<PublicPromptGenerationSet[]> {
  const database = getDatabase();
  const scope = scopeCondition(auth);
  const latestCreatedAt = max(savedPrompts.createdAt);
  const rows = await database
    .select({
      generationId: savedPrompts.generationId,
      seed: savedPrompts.seed,
      category: savedPrompts.category,
      assetType: savedPrompts.assetType,
      locale: savedPrompts.locale,
      createdAt: latestCreatedAt,
      promptCount: count(savedPrompts.id)
    })
    .from(savedPrompts)
    .where(scope)
    .groupBy(savedPrompts.generationId)
    .orderBy(desc(latestCreatedAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  const generationIds = rows.map((row) => row.generationId).filter((id): id is string => Boolean(id));
  const generations = generationIds.length
    ? await database.select().from(aiRecommendations).where(inArray(aiRecommendations.id, generationIds))
    : [];
  const generationMap = new Map(generations.map((item) => [item.id, item]));
  return rows.map((row) => {
    const generation = row.generationId ? generationMap.get(row.generationId) : undefined;
    const createdAt = asDate(generation?.createdAt ?? row.createdAt);
    return {
      id: row.generationId ?? `ungrouped-${createdAt.toISOString().slice(0, 10)}`,
      title: generation?.generationTitle || `${row.seed} · ${row.assetType === "videos" ? "Video" : "Image"} · ${createdAt.toLocaleDateString("en-GB")}`,
      seed: row.seed,
      category: row.category,
      assetType: row.assetType,
      locale: row.locale,
      style: generation?.recommendedStyle || "",
      createdAt,
      promptCount: Number(row.promptCount),
      prompts: []
    };
  });
}

export async function getPromptGenerationSet(
  generationId: string,
  limit = LIBRARY_PAGE_SIZE,
  offset = 0,
  auth?: AuthContext | null
): Promise<PublicPromptGenerationSet | null> {
  const database = getDatabase();
  const scope = scopeCondition(auth);
  const generationCondition = eq(savedPrompts.generationId, generationId);
  const where = scope ? and(generationCondition, scope) : generationCondition;
  const safeLimit = Math.min(Math.max(limit, 1), LIBRARY_PAGE_SIZE);
  const safeOffset = Math.max(offset, 0);
  const [countRow] = await database.select({ promptCount: count(savedPrompts.id) }).from(savedPrompts).where(where);
  if (!Number(countRow?.promptCount)) return null;
  const prompts = await database
    .select()
    .from(savedPrompts)
    .where(where)
    .orderBy(desc(savedPrompts.createdAt))
    .limit(safeLimit)
    .offset(safeOffset);
  const [generation] = await database.select().from(aiRecommendations).where(eq(aiRecommendations.id, generationId)).limit(1);
  const firstPrompt = prompts[0];
  const createdAt = asDate(generation?.createdAt ?? firstPrompt?.createdAt);
  return {
    id: generationId,
    title: generation?.generationTitle || (firstPrompt ? `${firstPrompt.seed} · ${firstPrompt.assetType === "videos" ? "Video" : "Image"} · ${createdAt.toLocaleDateString("en-GB")}` : generationId),
    seed: firstPrompt?.seed ?? "",
    category: firstPrompt?.category ?? "general",
    assetType: firstPrompt?.assetType ?? "images",
    locale: firstPrompt?.locale ?? "en-GB",
    style: generation?.recommendedStyle || "",
    createdAt,
    promptCount: Number(countRow.promptCount),
    prompts: prompts.map(publicSavedPrompt)
  };
}

export async function deleteSavedPrompt(id: string, auth?: AuthContext | null) {
  const database = getDatabase();
  const scope = scopeCondition(auth);
  const result = await database
    .delete(savedPrompts)
    .where(scope ? and(eq(savedPrompts.id, id), scope) : eq(savedPrompts.id, id))
    .returning({ id: savedPrompts.id });
  return result.length ? { deleted: true, promptId: id } : null;
}

export async function deletePromptGenerationSet(generationId: string, auth?: AuthContext | null) {
  const scope = scopeCondition(auth);
  const result = await getDatabase().delete(savedPrompts).where(
    scope ? and(eq(savedPrompts.generationId, generationId), scope) : eq(savedPrompts.generationId, generationId)
  ).returning({ id: savedPrompts.id });
  return result.length ? { deleted: true, generationId, promptCount: result.length } : null;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export async function exportSavedPrompts(
  format: "csv" | "txt",
  auth?: AuthContext | null,
  generationId?: string,
  promptIds: string[] = []
): Promise<string> {
  const selectedIds = new Set(promptIds.filter(Boolean));
  const rows = (await listSavedPrompts(1_000, auth)).filter((row) =>
    (!generationId || row.generationId === generationId) && (!selectedIds.size || selectedIds.has(row.id))
  );
  if (rows.length) {
    const database = getDatabase();
    const scope = scopeCondition(auth);
    const exportedIds = rows.map((row) => row.id);
    const exportedCondition = inArray(savedPrompts.id, exportedIds);
    await database.update(savedPrompts).set({ status: "downloaded", updatedAt: new Date() }).where(
      scope ? and(exportedCondition, scope) : exportedCondition
    );
  }
  if (format === "txt") return rows.map((row) => row.prompt.replace(/\r?\n/g, " ").trim()).join("\n");

  const header = ["id", "title", "prompt", "negative_prompt", "keyword_focus", "seed", "category", "asset_type", "locale", "status", "created_at"];
  const lines = rows.map((row) => [
    row.id,
    row.title,
    row.prompt.replace(/\r?\n/g, " "),
    row.negativePrompt.replace(/\r?\n/g, " "),
    row.keywordFocus.join(" | "),
    row.seed,
    row.category,
    row.assetType,
    row.locale,
    row.status,
    row.createdAt.toISOString()
  ].map(csvCell).join(","));
  return [header.map(csvCell).join(","), ...lines].join("\n");
}
