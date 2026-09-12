import type { FastifyInstance } from "fastify";
import {
  createGeminiApiKey,
  deleteGeminiApiKey,
  listGeminiApiKeys,
  setGeminiApiKeyStatus
} from "../services/gemini-key.service";
import { DEFAULT_GEMINI_MODEL, testUserGeminiKey } from "../services/gemini.service";

interface CreateKeyBody { label?: unknown; apiKey?: unknown }
interface StatusBody { status?: unknown }

function userId(request: { auth: { userId: string } | null }) {
  return request.auth?.userId ?? "";
}

export async function geminiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/gemini/keys", async (request) => {
    return listGeminiApiKeys(userId(request));
  });

  app.post<{ Body: CreateKeyBody }>("/api/gemini/keys", async (request, reply) => {
    const label = typeof request.body?.label === "string" ? request.body.label : "Gemini key";
    const apiKey = typeof request.body?.apiKey === "string" ? request.body.apiKey : "";
    try {
      const result = await createGeminiApiKey(userId(request), label, apiKey);
      return reply.status(201).send(result);
    } catch (error) {
      return reply.status(400).send({
        error: "INVALID_GEMINI_KEY",
        message: error instanceof Error ? error.message : "Gemini API key tidak valid"
      });
    }
  });

  app.post<{ Params: { id: string }; Body: { model?: unknown } }>("/api/gemini/keys/:id/test", async (request, reply) => {
    const keys = await listGeminiApiKeys(userId(request));
    if (!keys.some((key) => key.id === request.params.id)) {
      return reply.status(404).send({ error: "GEMINI_KEY_NOT_FOUND" });
    }
    try {
      return await testUserGeminiKey(
        userId(request),
        typeof request.body?.model === "string" ? request.body.model : DEFAULT_GEMINI_MODEL,
        request.params.id
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gemini key test gagal";
      return reply.status(message === "NO_GEMINI_API_KEY" ? 400 : 502).send({
        error: message === "NO_GEMINI_API_KEY" ? message : "GEMINI_KEY_TEST_FAILED",
        message
      });
    }
  });

  app.patch<{ Params: { id: string }; Body: StatusBody }>("/api/gemini/keys/:id/status", async (request, reply) => {
    const status = request.body?.status;
    if (status !== "active" && status !== "disabled") {
      return reply.status(400).send({ error: "INVALID_STATUS" });
    }
    const result = await setGeminiApiKeyStatus(userId(request), request.params.id, status);
    return result ? result : reply.status(404).send({ error: "GEMINI_KEY_NOT_FOUND" });
  });

  app.delete<{ Params: { id: string } }>("/api/gemini/keys/:id", async (request, reply) => {
    const deleted = await deleteGeminiApiKey(userId(request), request.params.id);
    return deleted ? { deleted: true } : reply.status(404).send({ error: "GEMINI_KEY_NOT_FOUND" });
  });
}
