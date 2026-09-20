import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getResearchRun } from "../services/research.service";
import { generatePromptSet } from "../services/prompt-generation.service";
import { deletePromptGenerationSet, deleteSavedPrompt, exportSavedPrompts, getPromptGenerationSet, listPromptGenerationSets, listSavedPrompts } from "../services/saved-prompt.service";
import { cancelPromptQueueItem, createPromptQueueItems, deletePromptQueueItem, generatePromptQueueItem, listPromptQueue, updatePromptQueueItem } from "../services/prompt-queue.service";

interface CreateBody {
  seed?: unknown;
  researchRunId?: unknown;
  category?: unknown;
  assetType?: unknown;
  locale?: unknown;
  count?: unknown;
  style?: unknown;
  model?: unknown;
  generationSeed?: unknown;
  generateAnother?: unknown;
}

interface PromptQueueBody {
  items?: unknown;
  keyword?: unknown;
  category?: unknown;
  researchAssetType?: unknown;
  promptOutputType?: unknown;
  locale?: unknown;
  promptCount?: unknown;
  recommendedStyle?: unknown;
  styleRationale?: unknown;
  sourceReadoutId?: unknown;
  sourceScore?: unknown;
  sourceLevel?: unknown;
  sourceConfidence?: unknown;
  sourceEvidence?: unknown;
  sourceObservedAt?: unknown;
  confirmLowConfidence?: unknown;
}

function authOrThrow(request: { auth: import("../auth").AuthContext | null }) {
  if (!request.auth) throw new Error("UNAUTHORIZED");
  return request.auth;
}

function normalizePromptQueueItems(body: PromptQueueBody, partialBatch = false) {
  const requestedItems = Array.isArray(body.items) ? body.items : [body];
  const rejected: Array<{ keyword: string; reason: string }> = [];
  const rawItems = partialBatch ? requestedItems.slice(0, 20) : requestedItems;
  if (partialBatch && requestedItems.length > 20) {
    rejected.push(...requestedItems.slice(20).map((item) => ({
      keyword: item && typeof item === "object" && typeof (item as Record<string, unknown>).keyword === "string"
        ? (item as Record<string, string>).keyword
        : "",
      reason: "MAX_BATCH_20"
    })));
  }
  const items = rawItems.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      if (partialBatch) rejected.push({ keyword: "", reason: "INVALID_ITEM" });
      return partialBatch ? [] : [{ keyword: "" }];
    }

    const value = item as Record<string, unknown>;
    const keyword = typeof value.keyword === "string" ? value.keyword.trim() : "";
    if (partialBatch && (!keyword || keyword.length > 160)) {
      rejected.push({ keyword, reason: "INVALID_KEYWORD" });
      return [];
    }
    if (partialBatch && value.researchAssetType !== undefined && value.researchAssetType !== "images" && value.researchAssetType !== "videos") {
      rejected.push({ keyword, reason: "INVALID_ASSET_TYPE" });
      return [];
    }
    if (partialBatch && value.promptOutputType !== undefined && value.promptOutputType !== "image" && value.promptOutputType !== "video") {
      rejected.push({ keyword, reason: "INVALID_OUTPUT_TYPE" });
      return [];
    }
    if (partialBatch && value.promptCount !== undefined && (!Number.isInteger(value.promptCount) || (value.promptCount as number) < 1 || (value.promptCount as number) > 20)) {
      rejected.push({ keyword, reason: "INVALID_PROMPT_COUNT" });
      return [];
    }
    if (partialBatch && value.sourceObservedAt !== undefined && value.sourceObservedAt !== null && typeof value.sourceObservedAt !== "string") {
      rejected.push({ keyword, reason: "INVALID_SOURCE_OBSERVED_AT" });
      return [];
    }

    return [{
      keyword,
      category: typeof value.category === "string" ? value.category : undefined,
      researchAssetType: value.researchAssetType === "videos" ? "videos" as const : "images" as const,
      promptOutputType: value.promptOutputType === "video" ? "video" as const : "image" as const,
      locale: typeof value.locale === "string" ? value.locale : undefined,
      promptCount: typeof value.promptCount === "number" ? value.promptCount : undefined,
      recommendedStyle: typeof value.recommendedStyle === "string" ? value.recommendedStyle : undefined,
      styleRationale: typeof value.styleRationale === "string" ? value.styleRationale : undefined,
      sourceReadoutId: typeof value.sourceReadoutId === "string" ? value.sourceReadoutId : undefined,
      sourceScore: typeof value.sourceScore === "number" ? value.sourceScore : undefined,
      sourceLevel: typeof value.sourceLevel === "number" ? value.sourceLevel : undefined,
      sourceConfidence: value.sourceConfidence === "low" || value.sourceConfidence === "medium" || value.sourceConfidence === "high" ? value.sourceConfidence as "low" | "medium" | "high" : undefined,
      sourceEvidence: Array.isArray(value.sourceEvidence) ? value.sourceEvidence.filter((entry): entry is string => typeof entry === "string") : undefined,
      sourceObservedAt: typeof value.sourceObservedAt === "string" ? value.sourceObservedAt : undefined
    }];
  });
  return { items, rejected };
}

async function createPromptQueueHandler(request: FastifyRequest<{ Body: PromptQueueBody }>, reply: FastifyReply, partialBatch = false) {
  const auth = authOrThrow(request);
  if (partialBatch && (!Array.isArray(request.body?.items) || request.body.items.length === 0)) {
    return reply.status(400).send({ error: "VALIDATION_ERROR", message: "Request tidak valid" });
  }
  try {
    const normalized = normalizePromptQueueItems(request.body ?? {}, partialBatch);
    const result = await createPromptQueueItems(normalized.items, auth);
    return {
      ...result,
      rejected: [...normalized.rejected, ...result.rejected],
      skipped: normalized.rejected.length + result.skipped
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Prompt queue gagal dibuat";
    return reply.status(400).send({ error: "PROMPT_QUEUE_INVALID", message });
  }
}

export async function promptRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: string } }>("/api/prompt-queue", async (request) => {
    return listPromptQueue(Number(request.query.limit ?? 100), authOrThrow(request));
  });

  const promptQueueSchema = {
    body: {
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["keyword"],
            properties: {
              keyword: { type: "string", minLength: 1, maxLength: 160 },
              category: { type: "string", minLength: 1, maxLength: 40 },
              researchAssetType: { type: "string", enum: ["images", "videos"] },
              promptOutputType: { type: "string", enum: ["image", "video"] },
              locale: { type: "string", minLength: 1, maxLength: 20 },
              promptCount: { type: "integer", minimum: 1, maximum: 20 },
              recommendedStyle: { type: "string", minLength: 1, maxLength: 160 },
              styleRationale: { type: "string", maxLength: 500 },
              sourceReadoutId: { type: "string", maxLength: 160 },
              sourceScore: { type: "number" },
              sourceLevel: { type: "number" },
              sourceConfidence: { type: "string", enum: ["low", "medium", "high"] },
              sourceEvidence: { type: "array", maxItems: 12, items: { type: "string", maxLength: 240 } },
              sourceObservedAt: { anyOf: [{ type: "string", maxLength: 80 }, { type: "null" }] }
            }
          }
        },
        keyword: { type: "string", minLength: 1, maxLength: 160 },
        category: { type: "string", minLength: 1, maxLength: 40 },
        researchAssetType: { type: "string", enum: ["images", "videos"] },
        promptOutputType: { type: "string", enum: ["image", "video"] },
        locale: { type: "string", minLength: 1, maxLength: 20 },
        promptCount: { type: "integer", minimum: 1, maximum: 20 },
        recommendedStyle: { type: "string", minLength: 1, maxLength: 160 },
        styleRationale: { type: "string", maxLength: 500 },
        sourceReadoutId: { type: "string", maxLength: 160 },
        sourceScore: { type: "number" },
        sourceLevel: { type: "number" },
        sourceConfidence: { type: "string", enum: ["low", "medium", "high"] },
        sourceEvidence: { type: "array", maxItems: 12, items: { type: "string", maxLength: 240 } },
        sourceObservedAt: { anyOf: [{ type: "string", maxLength: 80 }, { type: "null" }] }
      },
      anyOf: [{ required: ["keyword"] }, { required: ["items"] }]
    }
  };

  const promptQueueBatchSchema = {
    body: {
      type: "object",
      required: ["items"],
      properties: {
        items: { type: "array", minItems: 1, items: {} }
      }
    }
  };

  app.post<{ Body: PromptQueueBody }>("/api/prompt-queue", { schema: promptQueueSchema }, createPromptQueueHandler);
  app.post<{ Body: PromptQueueBody }>(
    "/api/prompt-queue/batch",
    { schema: promptQueueBatchSchema },
    async (request, reply) => createPromptQueueHandler(request, reply, true)
  );

  app.patch<{ Params: { id: string }; Body: PromptQueueBody }>("/api/prompt-queue/:id", async (request, reply) => {
    const body = request.body ?? {};
    const item = await updatePromptQueueItem(request.params.id, {
      promptCount: typeof body.promptCount === "number" ? body.promptCount : undefined,
      promptOutputType: body.promptOutputType === "video" ? "video" : body.promptOutputType === "image" ? "image" : undefined,
      recommendedStyle: typeof body.recommendedStyle === "string" ? body.recommendedStyle : undefined
    }, authOrThrow(request));
    return item ?? reply.status(404).send({ error: "PROMPT_QUEUE_NOT_FOUND" });
  });

  app.post<{ Params: { id: string }; Body: { confirmLowConfidence?: unknown } }>("/api/prompt-queue/:id/generate", async (request, reply) => {
    try {
      const result = await generatePromptQueueItem(request.params.id, authOrThrow(request), { confirmLowConfidence: request.body?.confirmLowConfidence === true });
      return result ?? reply.status(404).send({ error: "PROMPT_QUEUE_NOT_FOUND" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Prompt generation gagal";
      const clientError = message === "NO_GEMINI_API_KEY" || message === "PROMPT_CONTEXT_EMPTY" || message === "LOW_CONFIDENCE_CONFIRMATION_REQUIRED";
      return reply.status(clientError ? 400 : 502).send({ error: clientError ? message : "PROMPT_GENERATION_FAILED", message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/prompt-queue/:id", async (request, reply) => {
    const result = await deletePromptQueueItem(request.params.id, authOrThrow(request));
    return result ?? reply.status(404).send({ error: "PROMPT_QUEUE_NOT_FOUND" });
  });

  app.post<{ Params: { id: string } }>("/api/prompt-queue/:id/cancel", async (request, reply) => {
    const result = await cancelPromptQueueItem(request.params.id, authOrThrow(request));
    return result ?? reply.status(404).send({ error: "PROMPT_QUEUE_NOT_FOUND" });
  });

  app.get<{ Querystring: { limit?: string } }>("/api/prompts", async (request) => {
    const limit = Number(request.query.limit ?? 100);
    return listSavedPrompts(Number.isFinite(limit) ? limit : 100, authOrThrow(request));
  });

  app.get<{ Querystring: { limit?: string } }>("/api/prompt-library", async (request) => {
    const limit = Number(request.query.limit ?? 100);
    return listPromptGenerationSets(Number.isFinite(limit) ? limit : 100, authOrThrow(request));
  });

  app.get<{ Params: { generationId: string }; Querystring: { limit?: string; offset?: string } }>("/api/prompt-library/:generationId", async (request, reply) => {
    const limit = Number(request.query.limit ?? 50);
    const offset = Number(request.query.offset ?? 0);
    const result = await getPromptGenerationSet(
      request.params.generationId,
      Number.isFinite(limit) ? limit : 50,
      Number.isFinite(offset) ? offset : 0,
      authOrThrow(request)
    );
    return result ?? reply.status(404).send({ error: "PROMPT_GENERATION_NOT_FOUND" });
  });

  app.delete<{ Params: { generationId: string } }>("/api/prompt-library/:generationId", async (request, reply) => {
    const result = await deletePromptGenerationSet(request.params.generationId, authOrThrow(request));
    return result ?? reply.status(404).send({ error: "PROMPT_GENERATION_NOT_FOUND" });
  });

  app.get<{ Params: { format: string }; Querystring: { generationId?: string; promptId?: string | string[] } }>("/api/prompts/export.:format", async (request, reply) => {
    const format = request.params.format === "txt" ? "txt" : request.params.format === "csv" ? "csv" : null;
    if (!format) return reply.status(400).send({ error: "INVALID_EXPORT_FORMAT" });
    const promptIds = request.query.promptId
      ? Array.isArray(request.query.promptId) ? request.query.promptId : [request.query.promptId]
      : [];
    const content = await exportSavedPrompts(format, authOrThrow(request), request.query.generationId, promptIds);
    reply.header("content-type", format === "csv" ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="stockscope-prompts.${format}"`);
    return reply.send(content);
  });

  app.delete<{ Params: { id: string } }>("/api/prompts/:id", async (request, reply) => {
    const result = await deleteSavedPrompt(request.params.id, authOrThrow(request));
    return result ?? reply.status(404).send({ error: "PROMPT_NOT_FOUND" });
  });

  app.post<{ Body: CreateBody }>(
    "/api/prompt-generations",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            seed: { type: "string", minLength: 1, maxLength: 160 },
            researchRunId: { type: "string", minLength: 1, maxLength: 160 },
            category: { type: "string", minLength: 1, maxLength: 40 },
            assetType: { type: "string", enum: ["images", "videos"] },
            locale: { type: "string", minLength: 1, maxLength: 20 },
            count: { type: "integer", minimum: 1, maximum: 20 },
            style: { type: "string", minLength: 1, maxLength: 160 },
            model: { type: "string", minLength: 1, maxLength: 120 },
            generationSeed: { type: "string", minLength: 1, maxLength: 160 },
            generateAnother: { type: "boolean" }
          }
        }
      }
    },
    async (request, reply) => {
    const auth = authOrThrow(request);
    const researchRunId = typeof request.body?.researchRunId === "string" ? request.body.researchRunId : undefined;
    if (researchRunId && !await getResearchRun(researchRunId, auth)) {
      return reply.status(404).send({ error: "RESEARCH_NOT_FOUND", message: "Research tidak ditemukan" });
    }

    try {
      const result = await generatePromptSet(auth.userId, auth, {
        seed: typeof request.body?.seed === "string" ? request.body.seed : undefined,
        researchRunId,
        category: typeof request.body?.category === "string" ? request.body.category : undefined,
        assetType: typeof request.body?.assetType === "string" ? request.body.assetType : undefined,
        locale: typeof request.body?.locale === "string" ? request.body.locale : undefined,
        count: typeof request.body?.count === "number" ? request.body.count : undefined,
        style: typeof request.body?.style === "string" ? request.body.style : undefined,
        model: typeof request.body?.model === "string" ? request.body.model : undefined,
        generationSeed: typeof request.body?.generationSeed === "string" ? request.body.generationSeed : undefined,
        generateAnother: request.body?.generateAnother === true
      });
      if (!result) {
        return reply.status(400).send({
          error: "PROMPT_CONTEXT_EMPTY",
          message: "Belum ada data research yang cukup untuk membuat prompt"
        });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Prompt generation gagal";
      if (message === "NO_GEMINI_API_KEY") return reply.status(400).send({ error: message, message: "Tambahkan Gemini API key Anda terlebih dahulu" });
      if (message === "PROMPT_VARIATION_LIMIT") return reply.status(400).send({ error: message, message: "Maksimal lima variasi untuk context ini sudah tercapai" });
      return reply.status(502).send({ error: "PROMPT_GENERATION_FAILED", message });
    }
  });
}
