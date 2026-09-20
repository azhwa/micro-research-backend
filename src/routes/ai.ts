import type { FastifyInstance } from "fastify";
import {
  completeAiRecommendation,
  failAiRecommendation,
  generateAiRecommendation,
  generateGlobalAiRecommendation,
  generateGlobalAiReadout,
  exportGlobalAiReadout,
  getAiRecommendation,
  listGlobalAiRecommendations,
  listAiRecommendations,
  prepareAiRecommendation
} from "../services/ai.service";
import { getResearchRun } from "../services/research.service";

interface PrepareBody { promptVersion?: unknown; model?: unknown }
interface ResultBody { response?: unknown; message?: unknown }
interface GenerateBody { model?: unknown }
interface GlobalGenerateBody { model?: unknown; assetType?: unknown; locale?: unknown; category?: unknown; type?: unknown }

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: GlobalGenerateBody }>("/api/ai-recommendations/global/generate", async (request, reply) => {
    try {
      const result = await generateGlobalAiRecommendation(request.auth?.userId ?? "", {
        model: typeof request.body?.model === "string" ? request.body.model : undefined,
        assetType: typeof request.body?.assetType === "string" ? request.body.assetType : undefined,
        locale: typeof request.body?.locale === "string" ? request.body.locale : undefined,
        category: typeof request.body?.category === "string" ? request.body.category : undefined
      }, request.auth);
      if (!result) {
        return reply.status(400).send({
          error: "GLOBAL_CONTEXT_EMPTY",
          message: "Belum ada snapshot global. Selesaikan minimal satu research terlebih dahulu."
        });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gemini request gagal";
      if (message === "NO_GEMINI_API_KEY") {
        return reply.status(400).send({ error: message, message: "Tambahkan Gemini API key Anda terlebih dahulu" });
      }
      return reply.status(502).send({ error: "GEMINI_REQUEST_FAILED", message });
    }
  });

  app.get<{ Querystring: { limit?: string } }>("/api/ai-recommendations/global", async (request) => {
    return listGlobalAiRecommendations(Number(request.query.limit ?? 20));
  });

  app.post<{ Body: GlobalGenerateBody }>("/api/ai-readouts/global/generate", async (request, reply) => {
    const type = request.body?.type === "keyword" ? "keyword" : "asset";
    try {
      const result = await generateGlobalAiReadout(request.auth?.userId ?? "", {
        type,
        model: typeof request.body?.model === "string" ? request.body.model : undefined,
        assetType: typeof request.body?.assetType === "string" ? request.body.assetType : undefined,
        locale: typeof request.body?.locale === "string" ? request.body.locale : undefined,
        category: typeof request.body?.category === "string" ? request.body.category : undefined
      }, request.auth);
      if (!result) return reply.status(400).send({ error: "GLOBAL_CONTEXT_EMPTY", message: "Belum ada snapshot global." });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gemini request gagal";
      if (message === "NO_GEMINI_API_KEY") return reply.status(400).send({ error: message, message: "Tambahkan Gemini API key Anda terlebih dahulu" });
      return reply.status(502).send({ error: "GEMINI_REQUEST_FAILED", message });
    }
  });

  app.get<{ Querystring: { limit?: string; type?: string; assetType?: string; locale?: string; category?: string } }>("/api/ai-readouts/global", async (request) => {
    return listGlobalAiRecommendations(Number(request.query.limit ?? 20), request.query.type === "keyword" || request.query.type === "asset" ? request.query.type : undefined, {
      assetType: request.query.assetType,
      locale: request.query.locale,
      category: request.query.category
    });
  });

  app.get<{ Params: { format: string }; Querystring: { type?: string; assetType?: string; locale?: string; category?: string } }>("/api/ai-readouts/global/export.:format", async (request, reply) => {
    const format = request.params.format === "txt" ? "txt" : request.params.format === "csv" ? "csv" : null;
    if (!format) return reply.status(400).send({ error: "INVALID_EXPORT_FORMAT" });
    const type = request.query.type === "keyword" || request.query.type === "asset" ? request.query.type : undefined;
    const content = await exportGlobalAiReadout(format, type, {
      assetType: request.query.assetType,
      locale: request.query.locale,
      category: request.query.category
    }, request.auth);
    reply.header("content-type", format === "csv" ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="stockscope-${type ?? "ai-readout"}.${format}"`);
    return reply.send(content);
  });

  app.post<{ Params: { id: string }; Body: GenerateBody }>("/api/research-runs/:id/ai-recommendations/generate", async (request, reply) => {
    if (!await getResearchRun(request.params.id, request.auth)) return reply.status(404).send({ error: "RESEARCH_NOT_FOUND" });
    try {
      const result = await generateAiRecommendation(request.params.id, request.auth?.userId ?? "", {
        model: typeof request.body?.model === "string" ? request.body.model : undefined
      });
      return result ?? reply.status(404).send({ error: "RESEARCH_NOT_FOUND" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gemini request gagal";
      if (message === "NO_GEMINI_API_KEY") {
        return reply.status(400).send({ error: message, message: "Tambahkan Gemini API key Anda terlebih dahulu" });
      }
      return reply.status(502).send({ error: "GEMINI_REQUEST_FAILED", message });
    }
  });

  app.post<{ Params: { id: string }; Body: PrepareBody }>("/api/research-runs/:id/ai-recommendations/prepare", async (request, reply) => {
    if (!await getResearchRun(request.params.id, request.auth)) return reply.status(404).send({ error: "RESEARCH_NOT_FOUND" });
    const result = await prepareAiRecommendation(request.params.id, {
      promptVersion: typeof request.body?.promptVersion === "string" ? request.body.promptVersion : undefined,
      model: typeof request.body?.model === "string" ? request.body.model : undefined
    });
    if (!result) return reply.status(404).send({ error: "RESEARCH_NOT_FOUND" });
    return result;
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/research-runs/:id/ai-recommendations", async (request, reply) => {
    if (!await getResearchRun(request.params.id, request.auth)) return reply.status(404).send({ error: "RESEARCH_NOT_FOUND" });
    return listAiRecommendations(request.params.id, Number(request.query.limit ?? 20));
  });

  app.post<{ Params: { id: string }; Body: ResultBody }>("/api/ai-recommendations/:id/complete", async (request, reply) => {
    if (request.body?.response === undefined) return reply.status(400).send({ error: "INVALID_RESPONSE", message: "response wajib diisi" });
    const existing = await getAiRecommendation(request.params.id);
    if (!existing || (existing.researchRunId && !await getResearchRun(existing.researchRunId, request.auth))) return reply.status(404).send({ error: "RECOMMENDATION_NOT_FOUND" });
    const result = await completeAiRecommendation(request.params.id, request.body.response);
    if (!result) return reply.status(404).send({ error: "RECOMMENDATION_NOT_FOUND" });
    return result;
  });

  app.post<{ Params: { id: string }; Body: ResultBody }>("/api/ai-recommendations/:id/fail", async (request, reply) => {
    const message = typeof request.body?.message === "string" ? request.body.message : "AI recommendation gagal";
    const existing = await getAiRecommendation(request.params.id);
    if (!existing || (existing.researchRunId && !await getResearchRun(existing.researchRunId, request.auth))) return reply.status(404).send({ error: "RECOMMENDATION_NOT_FOUND" });
    const result = await failAiRecommendation(request.params.id, message);
    if (!result) return reply.status(404).send({ error: "RECOMMENDATION_NOT_FOUND" });
    return result;
  });
}
