import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { aiRecommendations } from "../db/schema";
import type { AuthContext } from "../auth";
import { saveGeneratedPrompts } from "./saved-prompt.service";
import { getAiContext } from "./insights.service";
import { getGlobalAiContext } from "./snapshot.service";
import {
  DEFAULT_GEMINI_MODEL,
  generateStructuredWithUserGeminiKey
} from "./gemini.service";

export const IMAGE_PROMPT_VERSION = "image-prompt-v1";
const MAX_PROMPTS = 20;
const MAX_TEXT = 160;

const imagePromptSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    prompts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          prompt: { type: "string" },
          negativePrompt: { type: "string" },
          keywordFocus: { type: "array", items: { type: "string" } },
          commercialRationale: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] }
        },
        required: ["title", "prompt", "negativePrompt", "keywordFocus", "commercialRationale", "confidence"]
      }
    },
    cautions: { type: "array", items: { type: "string" } }
  },
  required: ["summary", "prompts", "cautions"]
};

type PromptInput = {
  seed?: string;
  researchRunId?: string;
  category?: string;
  assetType?: string;
  locale?: string;
  count?: number;
  style?: string;
  model?: string;
};

function text(value: unknown, maxLength = MAX_TEXT) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function count(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_PROMPTS)
    : 5;
}

function parseJson(value: string | null) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function normalizePromptResponse(value: unknown) {
  const source = value && typeof value === "object" ? value as Record<string, any> : {};
  const prompts = Array.isArray(source.prompts) ? source.prompts.map((item: any) => ({
    title: text(item?.title, 160),
    prompt: text(item?.prompt, 2_000),
    negativePrompt: text(item?.negativePrompt, 1_000),
    keywordFocus: Array.isArray(item?.keywordFocus) ? item.keywordFocus.filter((entry: unknown): entry is string => typeof entry === "string").slice(0, 12) : [],
    commercialRationale: text(item?.commercialRationale, 600),
    confidence: item?.confidence === "high" || item?.confidence === "low" ? item.confidence : "medium"
  })) : [];
  return {
    summary: text(source.summary, 800),
    prompts,
    cautions: Array.isArray(source.cautions) ? source.cautions.filter((entry: unknown): entry is string => typeof entry === "string").slice(0, 8) : []
  };
}

function publicPromptGeneration(row: typeof aiRecommendations.$inferSelect) {
  return {
    id: row.id,
    scope: row.scope,
    promptVersion: row.promptVersion,
    model: row.model,
    inputHash: row.inputHash,
    status: row.status,
    response: row.responseJson ? normalizePromptResponse(parseJson(row.responseJson)) : null,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt
  };
}

function compactContext(context: unknown, input: Required<Pick<PromptInput, "seed" | "category" | "assetType" | "locale">>) {
  const source = context && typeof context === "object" ? context as Record<string, any> : {};
  return {
    schemaVersion: "image-prompt-context-1",
    request: input,
    scoring: source.scores ?? null,
    dataQuality: source.dataQuality ?? null,
    dataAge: source.dataAge ?? null,
    topKeywords: Array.isArray(source.topKeywords) ? source.topKeywords.slice(0, 40).map((item: any) => ({
      keyword: item.keyword,
      opportunityScore: item.opportunityScore ?? item.globalOpportunityScore ?? null,
      level: item.level,
      confidence: item.confidence,
      researchCount: item.researchCount,
      assetCount: item.assetCount,
      resultCount: item.resultCount ?? item.averageResultCount,
      trend: item.trend,
      sources: item.sources
    })) : [],
    topAssets: Array.isArray(source.topAssets) ? source.topAssets.slice(0, 20).map((item: any) => ({
      title: text(item.title, 180),
      assetType: item.assetType,
      assetScore: item.assetScore ?? item.bestAssetScore,
      appearances: item.appearances,
      researchCount: item.researchCount,
      seenForKeywords: Array.isArray(item.seenForKeywords) ? item.seenForKeywords.slice(0, 8) : []
    })) : []
  };
}

function promptForContext(context: unknown, requestedCount: number, style: string) {
  return [
    "Anda adalah art director microstock yang membuat prompt untuk generator gambar AI eksternal seperti Adobe Firefly atau Midjourney.",
    `Buat tepat ${requestedCount} prompt gambar yang berbeda tetapi tetap relevan dengan data riset.`,
    `Gaya produksi: ${style || "commercial stock photography"}.`,
    "Gunakan keyword dan asset evidence sebagai arah konsep, bukan sebagai klaim penjualan.",
    "Prompt harus siap copy-paste, konkret, mendeskripsikan subjek, aksi, setting, pencahayaan, komposisi, ruang copy space, dan kualitas stock yang bersih.",
    "Prioritaskan konsep komersial yang mudah diberi metadata dan hindari logo, merek, karakter berhak cipta, nama artis, watermark, teks acak, dan klaim penjualan.",
    "Setiap prompt harus memiliki angle visual berbeda. Jangan mengulang kalimat prompt.",
    "Negative prompt harus ringkas dan relevan untuk mengurangi artefak, teks, logo, watermark, anatomi buruk, dan duplikasi.",
    "Confidence hanya mengukur kekuatan evidence dari data, bukan jaminan gambar akan laku.",
    "Kembalikan hanya JSON sesuai schema, tanpa markdown.",
    "DATA RISET:",
    JSON.stringify(context)
  ].join("\n");
}

export async function generatePromptSet(userId: string, auth: AuthContext, input: PromptInput) {
  const seed = text(input.seed, 120);
  const category = text(input.category, 40) || "general";
  const assetType = input.assetType === "videos" ? "videos" : "images";
  const locale = text(input.locale, 20) || "en-GB";
  const requestedCount = count(input.count);
  const style = text(input.style, 120) || "commercial stock photography";
  const model = text(input.model, 120) || DEFAULT_GEMINI_MODEL;

  let rawContext: unknown;
  if (input.researchRunId) {
    rawContext = await getAiContext(input.researchRunId);
  } else {
    rawContext = await getGlobalAiContext({ assetType, locale, category }, auth);
  }
  if (!rawContext) return null;

  const context = compactContext(rawContext, { seed, category, assetType, locale });
  const inputHash = createHash("sha256")
    .update(JSON.stringify({ scope: "prompt", promptVersion: IMAGE_PROMPT_VERSION, model, requestedCount, style, context }))
    .digest("hex");
  const database = getDatabase();
  const existing = await database.select().from(aiRecommendations).where(eq(aiRecommendations.inputHash, inputHash)).limit(1);
  if (existing[0]?.status === "completed") {
    const generation = publicPromptGeneration(existing[0]);
    if (generation.response) await persistSavedPrompts(existing[0].id, auth, context, generation.response);
    return { generation, context };
  }

  let row = existing[0];
  if (row) {
    const [updated] = await database.update(aiRecommendations).set({
      status: "pending",
      requestJson: JSON.stringify(context),
      responseJson: null,
      errorMessage: null,
      updatedAt: new Date(),
      completedAt: null
    }).where(eq(aiRecommendations.id, row.id)).returning();
    row = updated ?? row;
  } else {
    const [created] = await database.insert(aiRecommendations).values({
      id: `prompt_${randomUUID()}`,
      researchRunId: input.researchRunId ?? null,
      scope: "prompt",
      promptVersion: IMAGE_PROMPT_VERSION,
      model,
      inputHash,
      status: "pending",
      requestJson: JSON.stringify(context)
    }).returning();
    row = created;
  }

  try {
    const response = await generateStructuredWithUserGeminiKey(
      userId,
      model,
      promptForContext({ ...context, style }, requestedCount, style),
      imagePromptSchema,
      Math.min(8_000, 1_000 + requestedCount * 700)
    );
    const normalizedResponse = normalizePromptResponse(response);
    const serialized = JSON.stringify(normalizedResponse);
    if (serialized.length > 250_000) throw new Error("Prompt response terlalu besar");
    const [completed] = await database.update(aiRecommendations).set({
      status: "completed",
      responseJson: serialized,
      errorMessage: null,
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(aiRecommendations.id, row.id)).returning();
    if (!completed) return null;
    const generation = publicPromptGeneration(completed);
    if (generation.response) await persistSavedPrompts(completed.id, auth, context, generation.response);
    return { generation, context };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Prompt generation gagal";
    await database.update(aiRecommendations).set({ status: "failed", errorMessage: message.slice(0, 1_000), updatedAt: new Date() }).where(eq(aiRecommendations.id, row.id));
    throw error;
  }
}

async function persistSavedPrompts(
  generationId: string,
  auth: AuthContext,
  context: Record<string, any>,
  response: { prompts: Array<{ title: string; prompt: string; negativePrompt: string; keywordFocus: string[]; commercialRationale: string; confidence: string }> }
) {
  const request = context.request ?? {};
  await saveGeneratedPrompts(response.prompts.map((item) => ({
    generationId,
    ownerUserId: auth.isDevBypass ? null : auth.userId,
    organizationId: auth.isDevBypass ? null : auth.organizationId,
    seed: text(request.seed, 120),
    category: text(request.category, 40) || "general",
    assetType: request.assetType === "videos" ? "videos" : "images",
    locale: text(request.locale, 20) || "en-GB",
    title: item.title,
    prompt: item.prompt,
    negativePrompt: item.negativePrompt,
    keywordFocus: item.keywordFocus,
    commercialRationale: item.commercialRationale,
    confidence: item.confidence
  })));
}
