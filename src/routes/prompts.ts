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

function normalizePromptQueueItems(body: PromptQueueBody) {
  const rawItems = Array.isArray(body.items) ? body.items : [body];
  return rawItems.map((item) => {
    const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      keyword: typeof value.keyword === "string" ? value.keyword : "",
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
    };
  });
}

async function createPromptQueueHandler(request: FastifyRequest<{ Body: PromptQueueBody }>, reply: FastifyReply) {
  const auth = authOrThrow(request);
  try {
    return await createPromptQueueItems(normalizePromptQueueItems(request.body ?? {}), auth);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Prompt queue gagal dibuat";
    return reply.status(400).send({ error: "PROMPT_QUEUE_INVALID", message });
  }
}

export async function promptRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: string } }>("/api/prompt-queue", async (request) => {
    return listPromptQueue(Number(request.query.limit ?? 100), authOrThrow(request));
  });

  app.post<{ Body: PromptQueueBody }>("/api/prompt-queue", createPromptQueueHandler);
  app.post<{ Body: PromptQueueBody }>("/api/prompt-queue/batch", createPromptQueueHandler);

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

  app.get<{ Params: { format: string }; Querystring: { generationId?: string } }>("/api/prompts/export.:format", async (request, reply) => {
    const format = request.params.format === "txt" ? "txt" : request.params.format === "csv" ? "csv" : null;
    if (!format) return reply.status(400).send({ error: "INVALID_EXPORT_FORMAT" });
    const content = await exportSavedPrompts(format, authOrThrow(request), request.query.generationId);
    reply.header("content-type", format === "csv" ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="stockscope-prompts.${format}"`);
    return reply.send(content);
  });

  app.delete<{ Params: { id: string } }>("/api/prompts/:id", async (request, reply) => {
    const result = await deleteSavedPrompt(request.params.id, authOrThrow(request));
    return result ?? reply.status(404).send({ error: "PROMPT_NOT_FOUND" });
  });

  app.post<{ Body: CreateBody }>("/api/prompt-generations", async (request, reply) => {
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
