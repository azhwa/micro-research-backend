import type { FastifyInstance } from "fastify";
import { getResearchRun } from "../services/research.service";
import { generatePromptSet } from "../services/prompt-generation.service";
import { deleteSavedPrompt, exportSavedPrompts, listSavedPrompts } from "../services/saved-prompt.service";

interface CreateBody {
  seed?: unknown;
  researchRunId?: unknown;
  category?: unknown;
  assetType?: unknown;
  locale?: unknown;
  count?: unknown;
  style?: unknown;
  model?: unknown;
}

function authOrThrow(request: { auth: import("../auth").AuthContext | null }) {
  if (!request.auth) throw new Error("UNAUTHORIZED");
  return request.auth;
}

export async function promptRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: string } }>("/api/prompts", async (request) => {
    const limit = Number(request.query.limit ?? 100);
    return listSavedPrompts(Number.isFinite(limit) ? limit : 100, authOrThrow(request));
  });

  app.get<{ Params: { format: string } }>("/api/prompts/export.:format", async (request, reply) => {
    const format = request.params.format === "txt" ? "txt" : request.params.format === "csv" ? "csv" : null;
    if (!format) return reply.status(400).send({ error: "INVALID_EXPORT_FORMAT" });
    const content = await exportSavedPrompts(format, authOrThrow(request));
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
        model: typeof request.body?.model === "string" ? request.body.model : undefined
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
      if (message === "NO_GEMINI_API_KEY") {
        return reply.status(400).send({ error: message, message: "Tambahkan Gemini API key Anda terlebih dahulu" });
      }
      return reply.status(502).send({ error: "PROMPT_GENERATION_FAILED", message });
    }
  });
}
