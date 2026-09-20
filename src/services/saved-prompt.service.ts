import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
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
  const prompts = await listSavedPrompts(Math.min(Math.max(limit * 20, 100), 1_000), auth);
  const generationIds = [...new Set(prompts.map((item) => item.generationId).filter((id): id is string => Boolean(id)))];
  const generations = generationIds.length
    ? await getDatabase().select().from(aiRecommendations).where(inArray(aiRecommendations.id, generationIds))
    : [];
  const generationMap = new Map(generations.map((item) => [item.id, item]));
  const groups = new Map<string, PublicPromptGenerationSet>();
  for (const prompt of prompts) {
    const id = prompt.generationId ?? `ungrouped-${prompt.createdAt.toISOString().slice(0, 10)}`;
    const generation = prompt.generationId ? generationMap.get(prompt.generationId) : undefined;
    const existing = groups.get(id);
    if (existing) {
      existing.prompts.push(prompt);
      existing.promptCount = existing.prompts.length;
      continue;
    }
    groups.set(id, {
      id,
      title: generation?.generationTitle || `${prompt.seed} · ${prompt.assetType === "videos" ? "Video" : "Image"} · ${prompt.createdAt.toLocaleDateString("en-GB")}`,
      seed: prompt.seed,
      category: prompt.category,
      assetType: prompt.assetType,
      locale: prompt.locale,
      style: generation?.recommendedStyle || "",
      createdAt: generation?.createdAt ?? new Date(prompt.createdAt),
      promptCount: 1,
      prompts: [prompt]
    });
  }
  return [...groups.values()]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, Math.min(Math.max(limit, 1), 100));
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

export async function exportSavedPrompts(format: "csv" | "txt", auth?: AuthContext | null, generationId?: string): Promise<string> {
  const rows = (await listSavedPrompts(1_000, auth)).filter((row) => !generationId || row.generationId === generationId);
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
