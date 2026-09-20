import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { aiRecommendations } from "../db/schema";
import { getAiContext } from "./insights.service";
import { getGlobalAiContext, getGlobalInsights } from "./snapshot.service";
import type { AuthContext } from "../auth";
import { DEFAULT_GEMINI_MODEL, generateStructuredWithUserGeminiKey, generateWithUserGeminiKey } from "./gemini.service";

const DEFAULT_PROMPT_VERSION = "recommendation-v1";
const GLOBAL_PROMPT_VERSION = "global-recommendation-v1";
const MAX_RESPONSE_BYTES = 200_000;

function parseJson(value: string | null) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function publicRecommendation(row: typeof aiRecommendations.$inferSelect) {
  return {
    id: row.id,
    researchRunId: row.researchRunId,
    scope: row.scope,
    readoutType: row.readoutType,
    promptVersion: row.promptVersion,
    model: row.model,
    inputHash: row.inputHash,
    contextHash: row.contextHash,
    generationGroupId: row.generationGroupId,
    generationIndex: row.generationIndex,
    generationSeed: row.generationSeed,
    generationTitle: row.generationTitle,
    outputType: row.outputType,
    recommendedStyle: row.recommendedStyle,
    readoutFilters: parseJson(row.readoutFiltersJson) ?? {},
    status: row.status,
    response: parseJson(row.responseJson),
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt
  };
}

export async function prepareAiRecommendation(researchRunId: string, options: { promptVersion?: string; model?: string } = {}) {
  const context = await getAiContext(researchRunId);
  if (!context) return null;
  const promptVersion = options.promptVersion?.trim() || DEFAULT_PROMPT_VERSION;
  const model = options.model?.trim() || null;
  const inputHash = createHash("sha256")
    .update(JSON.stringify({ promptVersion, model, context }))
    .digest("hex");
  const database = getDatabase();
  const existing = await database.select().from(aiRecommendations).where(eq(aiRecommendations.inputHash, inputHash)).limit(1);
  if (existing[0]) return { recommendation: publicRecommendation(existing[0]), context };

  const id = `ai_${randomUUID()}`;
  const [row] = await database.insert(aiRecommendations).values({
    id,
    researchRunId,
    scope: "run",
    promptVersion,
    model,
    inputHash,
    status: "pending",
    requestJson: JSON.stringify(context)
  }).returning();
  return { recommendation: publicRecommendation(row), context };
}

export async function listAiRecommendations(researchRunId: string, limit = 20) {
  const rows = await getDatabase().select().from(aiRecommendations)
    .where(eq(aiRecommendations.researchRunId, researchRunId))
    .orderBy(desc(aiRecommendations.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map(publicRecommendation);
}

export async function getAiRecommendation(id: string) {
  const [row] = await getDatabase().select().from(aiRecommendations).where(eq(aiRecommendations.id, id)).limit(1);
  return row ? publicRecommendation(row) : null;
}

export async function completeAiRecommendation(id: string, response: unknown) {
  const serialized = JSON.stringify(response);
  if (serialized.length > MAX_RESPONSE_BYTES) throw new Error("AI response terlalu besar");
  const [row] = await getDatabase().update(aiRecommendations).set({
    status: "completed",
    responseJson: serialized,
    errorMessage: null,
    completedAt: new Date(),
    updatedAt: new Date()
  }).where(eq(aiRecommendations.id, id)).returning();
  return row ? publicRecommendation(row) : null;
}

export async function failAiRecommendation(id: string, message: string) {
  const [row] = await getDatabase().update(aiRecommendations).set({
    status: "failed",
    errorMessage: message.slice(0, 1_000),
    updatedAt: new Date()
  }).where(eq(aiRecommendations.id, id)).returning();
  return row ? publicRecommendation(row) : null;
}

export async function generateAiRecommendation(
  researchRunId: string,
  userId: string,
  options: { model?: string } = {}
) {
  const prepared = await prepareAiRecommendation(researchRunId, {
    promptVersion: DEFAULT_PROMPT_VERSION,
    model: options.model || DEFAULT_GEMINI_MODEL
  });
  if (!prepared) return null;

  if (prepared.recommendation.status === "completed") return prepared;

  try {
    const response = await generateWithUserGeminiKey(
      userId,
      options.model || DEFAULT_GEMINI_MODEL,
      prepared.context
    );
    const recommendation = await completeAiRecommendation(prepared.recommendation.id, response);
    return recommendation ? { recommendation, context: prepared.context } : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gemini request failed";
    await failAiRecommendation(prepared.recommendation.id, message);
    throw error;
  }
}

export async function listGlobalAiRecommendations(limit = 20, readoutType?: "asset" | "keyword", filters: { assetType?: string; locale?: string; category?: string } = {}) {
  const conditions = [eq(aiRecommendations.scope, "global")];
  if (readoutType) conditions.push(eq(aiRecommendations.readoutType, readoutType));
  const rows = await getDatabase().select().from(aiRecommendations)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(desc(aiRecommendations.createdAt))
    .limit(100);
  if (!readoutType && !filters.assetType && !filters.locale && !filters.category) {
    return rows.slice(0, Math.min(Math.max(limit, 1), 100)).map(publicRecommendation);
  }
  const matching = rows.filter((row) => {
    const saved = parseJson(row.readoutFiltersJson) as Record<string, unknown> | null;
    if (!saved) return false;
    return (!filters.assetType || filters.assetType === "all" || saved.assetType === filters.assetType)
      && (!filters.locale || filters.locale === "all" || saved.locale === filters.locale)
      && (!filters.category || filters.category === "all" || saved.category === filters.category);
  });
  return matching.slice(0, Math.min(Math.max(limit, 1), 100)).map(publicRecommendation);
}

const assetReadoutSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    overallAssessment: { type: "string" },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          assetConcept: { type: "string" },
          sourceAssetIds: { type: "array", items: { type: "string" } },
          sourceAssetUrls: { type: "array", items: { type: "string" } },
          keywordSuggestions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                keyword: { type: "string" },
                score: { type: "number" },
                level: { type: "number" },
                label: { type: "string" },
                confidence: { type: "string", enum: ["low", "medium", "high"] }
              },
              required: ["keyword", "score", "level", "label", "confidence"]
            }
          },
          recommendedStyle: { type: "string" },
          styleRationale: { type: "string" },
          format: { type: "string", enum: ["image", "video"] },
          promptDirection: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          confidence: { type: "string", enum: ["low", "medium", "high"] }
        },
        required: ["assetConcept", "sourceAssetIds", "sourceAssetUrls", "keywordSuggestions", "recommendedStyle", "styleRationale", "format", "promptDirection", "evidence", "confidence"]
      }
    },
    cautions: { type: "array", items: { type: "string" } }
  },
  required: ["summary", "overallAssessment", "recommendations", "cautions"]
};

const keywordReadoutSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    keywords: {
      type: "array",
      items: {
        type: "object",
        properties: {
          keyword: { type: "string" },
          recommendedStyle: { type: "string" },
          styleRationale: { type: "string" },
          whyItMatters: { type: "string" },
          opportunityScore: { type: "number" },
          level: { type: "number" },
          label: { type: "string" },
          researchCount: { type: "number" },
          assetCount: { type: "number" },
          averageDownloadRank: { type: "number" },
          averageResultCount: { type: "number" },
          lastObservedAt: { type: "string" },
          evidenceKeywords: { type: "array", items: { type: "string" } },
          styleConfidence: { type: "string", enum: ["low", "medium", "high"] },
          confidence: { type: "string", enum: ["low", "medium", "high"] }
        },
        required: ["keyword", "recommendedStyle", "styleRationale", "whyItMatters", "opportunityScore", "level", "label", "researchCount", "assetCount", "averageDownloadRank", "averageResultCount", "lastObservedAt", "evidenceKeywords", "styleConfidence", "confidence"]
      }
    },
    cautions: { type: "array", items: { type: "string" } }
  },
  required: ["summary", "keywords", "cautions"]
};

function keywordReadoutPrompt(context: unknown) {
  return [
    "Anda adalah analis keyword microstock yang bekerja dengan evidence Adobe Stock.",
    "Pilih keyword global yang paling layak dijadikan arah prompt berdasarkan score, frekuensi research, cross-sort evidence, dan confidence yang tersedia.",
    "Untuk setiap keyword, pilih satu style visual yang paling cocok dari katalog: commercial stock photography, editorial lifestyle, product still life, isolated subject, cinematic image, commercial stock video, cinematic video, editorial footage, aerial, macro, atau timelapse. Style bukan jaminan penjualan; jelaskan alasan visual dan komersialnya.",
    "Salin score, level, label, researchCount, assetCount, rank, result count, lastObservedAt, dan evidenceKeywords dari data yang tersedia. Jika nilai tidak tersedia, gunakan 0 atau string kosong, jangan mengarang.",
    "Jangan mengarang download, view, revenue, atau trend yang tidak ada. Jika evidence lemah, turunkan confidence dan tulis caution.",
    "Kembalikan 5 sampai 20 keyword unik, JSON saja sesuai schema.",
    "DATA RISET:",
    JSON.stringify(context)
  ].join("\n");
}

function assetReadoutPrompt(context: unknown, novelty: Record<string, unknown>) {
  return [
    "Anda adalah analis konsep visual microstock yang bekerja dengan evidence Adobe Stock.",
    "Pilih beberapa asset atau konsep yang memiliki sinyal observasi paling kuat, lalu turunkan keyword dan style visual yang dapat langsung dipakai untuk membuat prompt.",
    "Keyword suggestions wajib disalin dari keyword global atau seenForKeywords pada data. Jangan membuat keyword baru yang tidak ada di data.",
    "Pilih satu recommendedStyle dari katalog: commercial stock photography, editorial lifestyle, product still life, isolated subject, cinematic image, commercial stock video, cinematic video, editorial footage, aerial, macro, atau timelapse.",
    "Jangan mengarang download, view, revenue, upload date, atau jaminan penjualan. Score dan level harus disalin dari data yang tersedia.",
    "Hindari asset concept, keyword, style, dan source asset yang sudah muncul dalam NOVELTY GUARD. Cari angle visual yang berbeda tetapi tetap evidence-based.",
    "Kembalikan JSON saja sesuai schema dengan 3 sampai 10 recommendations.",
    "NOVELTY GUARD:",
    JSON.stringify(novelty),
    "DATA RISET:",
    JSON.stringify(context)
  ].join("\n");
}

const STYLE_CATALOG = new Set([
  "commercial stock photography", "editorial lifestyle", "product still life", "isolated subject", "cinematic image",
  "commercial stock video", "cinematic video", "editorial footage", "aerial", "macro", "timelapse"
]);

function normalizeStyle(value: unknown) {
  return typeof value === "string" && STYLE_CATALOG.has(value) ? value : "commercial stock photography";
}

function normalizeAssetReadout(value: unknown, context: Record<string, any>, defaultFormat: "image" | "video") {
  const source = value && typeof value === "object" ? value as Record<string, any> : {};
  const topAssets = Array.isArray(context.topAssets) ? context.topAssets : [];
  const topKeywords = Array.isArray(context.topKeywords) ? context.topKeywords : [];
  const assetsById = new Map(topAssets.map((item: any) => [String(item.externalId ?? ""), item]));
  const assetsByUrl = new Map(topAssets.map((item: any) => [String(item.assetUrl ?? ""), item]));
  const keywordEvidence = new Map<string, any>();
  for (const item of topKeywords) {
    const key = String(item.keyword ?? "").trim().toLowerCase();
    if (key) keywordEvidence.set(key, item);
  }
  for (const item of topAssets) {
    for (const keyword of Array.isArray(item.seenForKeywords) ? item.seenForKeywords : []) {
      const key = String(keyword).trim().toLowerCase();
      if (key && !keywordEvidence.has(key)) keywordEvidence.set(key, { keyword });
    }
  }
  const recommendations = Array.isArray(source.recommendations) ? source.recommendations.slice(0, 10).map((item: any) => {
    const sourceAssetIds = Array.isArray(item?.sourceAssetIds)
      ? item.sourceAssetIds.map((id: unknown) => String(id)).filter((id: string) => assetsById.has(id)).slice(0, 8)
      : [];
    const sourceAssetUrls = Array.isArray(item?.sourceAssetUrls)
      ? item.sourceAssetUrls.map((url: unknown) => String(url)).filter((url: string) => assetsByUrl.has(url)).slice(0, 8)
      : [];
    const keywordSuggestions = Array.isArray(item?.keywordSuggestions) ? item.keywordSuggestions.slice(0, 8).map((entry: any) => {
      const keyword = typeof entry?.keyword === "string" ? entry.keyword.trim().slice(0, 120) : "";
      const evidence = keywordEvidence.get(keyword.toLowerCase());
      return {
        keyword,
        score: typeof entry?.score === "number" ? Math.max(0, Math.min(100, entry.score)) : evidence?.globalOpportunityScore ?? null,
        level: typeof entry?.level === "number" ? Math.max(0, Math.min(5, Math.round(entry.level))) : evidence?.level ?? 0,
        label: typeof entry?.label === "string" ? entry.label.trim().slice(0, 60) : evidence?.label ?? "insufficient evidence",
        confidence: entry?.confidence === "high" || entry?.confidence === "medium" ? entry.confidence : "low"
      };
    }).filter((entry: any) => entry.keyword && keywordEvidence.has(entry.keyword.toLowerCase())) : [];
    const source = sourceAssetIds.map((id: string) => assetsById.get(id)).find(Boolean) ?? sourceAssetUrls.map((url: string) => assetsByUrl.get(url)).find(Boolean);
    return {
      assetConcept: typeof item?.assetConcept === "string" ? item.assetConcept.trim().slice(0, 180) : source?.title ?? "",
      sourceAssetIds,
      sourceAssetUrls,
      keywordSuggestions,
      recommendedStyle: normalizeStyle(item?.recommendedStyle),
      styleRationale: typeof item?.styleRationale === "string" ? item.styleRationale.trim().slice(0, 500) : "",
      format: item?.format === "video" ? "video" : defaultFormat,
      promptDirection: typeof item?.promptDirection === "string" ? item.promptDirection.trim().slice(0, 600) : "",
      evidence: Array.isArray(item?.evidence) ? item.evidence.filter((entry: unknown): entry is string => typeof entry === "string").slice(0, 8) : [],
      confidence: item?.confidence === "high" || item?.confidence === "medium" ? item.confidence : "low"
    };
  }).filter((item: any) => item.assetConcept) : [];
  return {
    summary: typeof source.summary === "string" ? source.summary.trim().slice(0, 800) : "",
    overallAssessment: typeof source.overallAssessment === "string" ? source.overallAssessment.trim().slice(0, 800) : "",
    recommendations,
    cautions: Array.isArray(source.cautions) ? source.cautions.filter((entry: unknown): entry is string => typeof entry === "string").slice(0, 8) : []
  };
}

function normalizeKeywordReadout(value: unknown) {
  const source = value && typeof value === "object" ? value as Record<string, any> : {};
  const keywords = Array.isArray(source.keywords) ? source.keywords.slice(0, 20).map((item: any) => ({
    keyword: typeof item?.keyword === "string" ? item.keyword.trim().slice(0, 120) : "",
    recommendedStyle: STYLE_CATALOG.has(item?.recommendedStyle) ? item.recommendedStyle : "commercial stock photography",
    styleRationale: typeof item?.styleRationale === "string" ? item.styleRationale.trim().slice(0, 500) : "",
    whyItMatters: typeof item?.whyItMatters === "string" ? item.whyItMatters.trim().slice(0, 500) : "",
    opportunityScore: typeof item?.opportunityScore === "number" ? Math.max(0, Math.min(100, item.opportunityScore)) : 0,
    level: typeof item?.level === "number" ? Math.max(0, Math.min(5, Math.round(item.level))) : 0,
    label: typeof item?.label === "string" ? item.label.trim().slice(0, 60) : "insufficient evidence",
    researchCount: typeof item?.researchCount === "number" ? Math.max(0, Math.round(item.researchCount)) : 0,
    assetCount: typeof item?.assetCount === "number" ? Math.max(0, Math.round(item.assetCount)) : 0,
    averageDownloadRank: typeof item?.averageDownloadRank === "number" ? item.averageDownloadRank : null,
    averageResultCount: typeof item?.averageResultCount === "number" ? item.averageResultCount : null,
    lastObservedAt: typeof item?.lastObservedAt === "string" ? item.lastObservedAt : null,
    evidenceKeywords: Array.isArray(item?.evidenceKeywords) ? item.evidenceKeywords.filter((entry: unknown): entry is string => typeof entry === "string").slice(0, 8) : [],
    styleConfidence: item?.styleConfidence === "high" || item?.styleConfidence === "medium" ? item.styleConfidence : "low",
    confidence: item?.confidence === "high" || item?.confidence === "medium" ? item.confidence : "low"
  })).filter((item: any) => item.keyword) : [];
  return {
    summary: typeof source.summary === "string" ? source.summary.trim().slice(0, 800) : "",
    keywords,
    cautions: Array.isArray(source.cautions) ? source.cautions.filter((entry: unknown): entry is string => typeof entry === "string").slice(0, 8) : []
  };
}

export async function generateGlobalAiReadout(
  userId: string,
  options: { type: "asset" | "keyword"; model?: string; assetType?: string; locale?: string; category?: string; generationSeed?: string; generateAnother?: boolean },
  auth?: AuthContext | null
) {
  const model = options.model?.trim() || DEFAULT_GEMINI_MODEL;
  const rawContext = await getGlobalAiContext({ assetType: options.assetType, locale: options.locale, category: options.category }, auth);
  if (!rawContext.topKeywords.length && !rawContext.topAssets.length) return null;
  const context = {
    ...rawContext,
    topKeywords: rawContext.topKeywords.slice(0, 50),
    topAssets: rawContext.topAssets.slice(0, 20)
  };
  const { generatedAt: _generatedAt, ...stableContext } = context;
  const promptVersion = options.type === "keyword" ? "global-keyword-readout-v1" : "global-asset-readout-v1";
  const contextHash = createHash("sha256").update(JSON.stringify({ scope: "global", readoutType: options.type, promptVersion, model, context: stableContext })).digest("hex");
  const generationGroupId = `global-readout:${options.type}:${contextHash}`;
  const database = getDatabase();
  const history = await database.select().from(aiRecommendations)
    .where(and(eq(aiRecommendations.scope, "global"), eq(aiRecommendations.readoutType, options.type), eq(aiRecommendations.contextHash, contextHash)))
    .orderBy(desc(aiRecommendations.generationIndex), desc(aiRecommendations.createdAt))
    .limit(10);
  const latest = history.find((item) => item.status === "completed");
  if (!options.generateAnother && !options.generationSeed && latest) return { recommendation: publicRecommendation(latest), context };
  if (options.generateAnother && history.length >= 5) throw new Error("READOUT_VARIATION_LIMIT");
  const generationIndex = (history[0]?.generationIndex ?? 0) + 1;
  const generationSeed = options.generationSeed?.trim().slice(0, 80) || (generationIndex === 1 ? "base" : `variation-${randomUUID().slice(0, 8)}`);
  const inputHash = createHash("sha256").update(JSON.stringify({ generationGroupId, generationIndex, generationSeed })).digest("hex");
  const existing = await database.select().from(aiRecommendations).where(eq(aiRecommendations.inputHash, inputHash)).limit(1);
  let row = existing[0];
  const noveltyContext = {
    previousGenerationCount: history.length,
    excludedConcepts: history.flatMap((item) => {
      const response = parseJson(item.responseJson) as Record<string, any> | null;
      return options.type === "asset"
        ? (Array.isArray(response?.recommendations) ? response.recommendations.map((entry: any) => entry.assetConcept) : [])
        : (Array.isArray(response?.keywords) ? response.keywords.map((entry: any) => entry.keyword) : []);
    }).filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 100),
    excludedStyles: history.flatMap((item) => {
      const response = parseJson(item.responseJson) as Record<string, any> | null;
      const entries = options.type === "asset" ? response?.recommendations : response?.keywords;
      return Array.isArray(entries) ? entries.map((entry: any) => entry.recommendedStyle) : [];
    }).filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 40)
  };
  const generationContext = { ...context, generation: { generationGroupId, generationIndex, generationSeed }, novelty: noveltyContext };
  const generationTitle = `${options.type === "asset" ? "Asset" : "Keyword"} Readout · ${context.filters.assetType}/${context.filters.locale}/${context.filters.category} · Variation ${generationIndex}`;
  if (row?.status === "completed") return { recommendation: publicRecommendation(row), context };
  if (row) {
    const [updated] = await database.update(aiRecommendations).set({ status: "pending", requestJson: JSON.stringify(generationContext), noveltyContextJson: JSON.stringify(noveltyContext), responseJson: null, errorMessage: null, updatedAt: new Date(), completedAt: null }).where(eq(aiRecommendations.id, row.id)).returning();
    row = updated ?? row;
  } else {
    const [created] = await database.insert(aiRecommendations).values({ id: `ai_${randomUUID()}`, researchRunId: null, scope: "global", readoutType: options.type, promptVersion, model, inputHash, contextHash, generationGroupId, generationIndex, generationSeed, generationTitle, noveltyContextJson: JSON.stringify(noveltyContext), outputType: context.filters.assetType === "videos" ? "video" : "image", readoutFiltersJson: JSON.stringify(context.filters), status: "pending", requestJson: JSON.stringify(generationContext) }).returning();
    row = created;
  }
  try {
    const response = options.type === "keyword"
      ? await generateStructuredWithUserGeminiKey(userId, model, keywordReadoutPrompt(generationContext), keywordReadoutSchema, 5_000)
      : await generateStructuredWithUserGeminiKey(userId, model, assetReadoutPrompt(generationContext, noveltyContext), assetReadoutSchema, 6_000);
    const normalized = options.type === "keyword" ? normalizeKeywordReadout(response) : normalizeAssetReadout(response, context, context.filters.assetType === "videos" ? "video" : "image");
    const recommendation = await completeAiRecommendation(row.id, normalized);
    return recommendation ? { recommendation, context } : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gemini request failed";
    await failAiRecommendation(row.id, message);
    throw error;
  }
}

export async function exportGlobalAiReadout(
  format: "csv" | "txt",
  readoutType: "asset" | "keyword" | undefined,
  filters: { assetType?: string; locale?: string; category?: string } = {},
  auth?: AuthContext | null
) {
  const type = readoutType === "keyword" ? "keyword" : "asset";
  const data = await getGlobalInsights({ ...filters, limit: 200 }, auth);
  const readouts = await listGlobalAiRecommendations(20, type, filters);
  const latest = readouts.find((row) => row.status === "completed") ?? readouts[0];
  const response = latest?.response && typeof latest.response === "object" ? latest.response as Record<string, any> : null;
  const cell = (value: unknown) => `"${String(Array.isArray(value) ? value.join(" | ") : value ?? "").replace(/"/g, '""')}"`;
  if (type === "keyword") {
    const aiItems = new Map<string, any>((Array.isArray(response?.keywords) ? response.keywords : []).map((item: any) => [String(item.keyword ?? "").toLowerCase(), item]));
    const rows = data.keywords.map((item, index) => {
      const ai = aiItems.get(item.normalizedKeyword) ?? aiItems.get(item.keyword.toLowerCase());
      return [item.globalRank ?? index + 1, item.keyword, item.level, item.label, item.globalOpportunityScore, item.averageDemandScore, item.averageCompetitionScore, item.trend, item.researchCount, item.assetCount, item.averageDownloadRank, item.averageResultCount, item.confidence, item.lastObservedAt, ai?.recommendedStyle ?? "", ai?.styleRationale ?? "", ai?.whyItMatters ?? ""];
    });
    if (format === "txt") return rows.map((row) => `${row[1]} — L${row[2]} ${row[3]} — score ${row[4] ?? "—"} — ${row[14] || "style belum dipilih"}`).join("\n");
    const header = ["rank", "keyword", "level", "label", "global_score", "demand_score", "competition_score", "trend", "research_count", "asset_count", "average_download_rank", "result_count", "confidence", "last_observed_at", "recommended_style", "style_rationale", "why_it_matters"];
    return [header, ...rows].map((row) => row.map(cell).join(",")).join("\n");
  }
  const assetRecommendations = Array.isArray(response?.recommendations) ? response.recommendations : [];
  const assetReadoutFor = (item: any) => assetRecommendations.find((entry: any) => {
    const ids = Array.isArray(entry?.sourceAssetIds) ? entry.sourceAssetIds.map((value: unknown) => String(value)) : [];
    const urls = Array.isArray(entry?.sourceAssetUrls) ? entry.sourceAssetUrls.map((value: unknown) => String(value)) : [];
    return ids.includes(String(item.externalId ?? "")) || urls.includes(String(item.assetUrl ?? ""));
  });
  const rows = data.assets.map((item, index) => {
    const ai = assetReadoutFor(item);
    const keywords = Array.isArray(ai?.keywordSuggestions) ? ai.keywordSuggestions.map((entry: any) => entry.keyword).join(" | ") : "";
    return [index + 1, item.title, item.assetUrl, item.thumbnailUrl, item.weightedScore, item.researchCount, item.bestDownloadRank, item.bestRelevanceRank, item.bestRecentRank, item.confidence, keywords, ai?.recommendedStyle ?? "", item.lastObservedAt];
  });
  if (format === "txt") return rows.map((row) => `${row[1]} — ${row[4] ?? "—"} — ${row[2]}`).join("\n");
  const header = ["rank", "asset_title", "asset_url", "thumbnail_url", "asset_score", "research_count", "best_download_rank", "best_relevance_rank", "best_recent_rank", "confidence", "keywords", "recommended_style", "observed_at"];
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\n");
}

export async function generateGlobalAiRecommendation(
  userId: string,
  options: { model?: string; assetType?: string; locale?: string; category?: string } = {},
  auth?: AuthContext | null
) {
  const model = options.model?.trim() || DEFAULT_GEMINI_MODEL;
  const context = await getGlobalAiContext({
    assetType: options.assetType,
    locale: options.locale,
    category: options.category
  }, auth);
  if (!context.topKeywords.length && !context.topAssets.length) return null;

  const { generatedAt: _generatedAt, ...stableContext } = context;
  const inputHash = createHash("sha256")
    .update(JSON.stringify({ scope: "global", promptVersion: GLOBAL_PROMPT_VERSION, model, context: stableContext }))
    .digest("hex");
  const database = getDatabase();
  const existing = await database.select().from(aiRecommendations).where(eq(aiRecommendations.inputHash, inputHash)).limit(1);

  let recommendationRow = existing[0];
  if (recommendationRow?.status === "completed") {
    return { recommendation: publicRecommendation(recommendationRow), context };
  }

  if (recommendationRow) {
    const [updated] = await database.update(aiRecommendations).set({
      status: "pending",
      requestJson: JSON.stringify(context),
      responseJson: null,
      errorMessage: null,
      updatedAt: new Date(),
      completedAt: null
    }).where(eq(aiRecommendations.id, recommendationRow.id)).returning();
    recommendationRow = updated ?? recommendationRow;
  } else {
    const [created] = await database.insert(aiRecommendations).values({
      id: `ai_${randomUUID()}`,
      researchRunId: null,
      scope: "global",
      promptVersion: GLOBAL_PROMPT_VERSION,
      model,
      inputHash,
      status: "pending",
      requestJson: JSON.stringify(context)
    }).returning();
    recommendationRow = created;
  }

  try {
    const response = await generateWithUserGeminiKey(userId, model, context);
    const recommendation = await completeAiRecommendation(recommendationRow.id, response);
    return recommendation ? { recommendation, context } : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gemini request failed";
    await failAiRecommendation(recommendationRow.id, message);
    throw error;
  }
}
