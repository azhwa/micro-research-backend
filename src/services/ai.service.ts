import { createHash, randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { aiRecommendations } from "../db/schema";
import { getAiContext } from "./insights.service";
import { getGlobalAiContext } from "./snapshot.service";
import { DEFAULT_GEMINI_MODEL, generateWithUserGeminiKey } from "./gemini.service";

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
    promptVersion: row.promptVersion,
    model: row.model,
    inputHash: row.inputHash,
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

export async function listGlobalAiRecommendations(limit = 20) {
  const rows = await getDatabase().select().from(aiRecommendations)
    .where(eq(aiRecommendations.scope, "global"))
    .orderBy(desc(aiRecommendations.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map(publicRecommendation);
}

export async function generateGlobalAiRecommendation(
  userId: string,
  options: { model?: string; assetType?: string; locale?: string; category?: string } = {}
) {
  const model = options.model?.trim() || DEFAULT_GEMINI_MODEL;
  const context = await getGlobalAiContext({
    assetType: options.assetType,
    locale: options.locale,
    category: options.category
  });
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
