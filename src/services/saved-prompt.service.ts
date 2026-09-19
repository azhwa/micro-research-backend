import { and, desc, eq, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/client";
import { savedPrompts } from "../db/schema";
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

export async function deleteSavedPrompt(id: string, auth?: AuthContext | null) {
  const database = getDatabase();
  const scope = scopeCondition(auth);
  const result = await database
    .delete(savedPrompts)
    .where(scope ? and(eq(savedPrompts.id, id), scope) : eq(savedPrompts.id, id))
    .returning({ id: savedPrompts.id });
  return result.length ? { deleted: true, promptId: id } : null;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export async function exportSavedPrompts(format: "csv" | "txt", auth?: AuthContext | null): Promise<string> {
  const rows = await listSavedPrompts(1_000, auth);
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
