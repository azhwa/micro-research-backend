import type { FastifyInstance } from "fastify";
import {
  getAiContext,
  getKeywordOpportunities,
  getResearchInsights,
  getTopAssets
} from "../services/insights.service";
import {
  cancelResearchRun,
  createResearchRun,
  deleteResearchRun,
  getResearchKeywords,
  getResearchResults,
  listResearchEvents,
  getResearchRun,
  listResearchRuns,
  type AssetType,
  type ResearchMode
} from "../services/research.service";
import { listResearchDetailLogs } from "../services/research-log.service";
import { invalidateGlobalInsightsCache } from "../services/snapshot.service";
import { env } from "../config/env";

interface CreateResearchBody {
  keyword?: unknown;
  category?: unknown;
  assetType?: unknown;
  locale?: unknown;
  maxSuggestions?: unknown;
  assetsPerQuery?: unknown;
  autocompleteEnabled?: unknown;
  mode?: unknown;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

export async function researchRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateResearchBody }>(
    "/api/research-runs",
    async (request, reply) => {
      const body = request.body ?? {};
      const requestedKeyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
      const category = typeof body.category === "string" && body.category.trim()
        ? body.category.trim().slice(0, 40)
        : "general";
      const assetType = body.assetType === "videos" ? "videos" : "images";
      const locale = typeof body.locale === "string" && body.locale.trim()
        ? body.locale.trim()
        : "en-GB";
      const maxSuggestions = positiveInteger(body.maxSuggestions, 30);
      const assetsPerQuery = positiveInteger(body.assetsPerQuery, 30);
      const autocompleteEnabled = body.autocompleteEnabled !== false;
      const mode: ResearchMode = body.mode === "fast" ? "fast" : body.mode === "primary" ? "primary" : "full";
      const keyword = mode === "primary" ? "" : requestedKeyword;

      if ((mode !== "primary" && !keyword) || keyword.length > 120) {
        return reply.status(400).send({
          error: "INVALID_KEYWORD",
          message: mode === "primary"
            ? "keyword maksimal 120 karakter"
            : "keyword wajib diisi dan maksimal 120 karakter"
        });
      }

      if (maxSuggestions > 50 || assetsPerQuery > 100) {
        return reply.status(400).send({
          error: "INVALID_LIMIT",
          message: "maxSuggestions maksimal 50 dan assetsPerQuery maksimal 100"
        });
      }

      const result = await createResearchRun({
        keyword,
        category,
        ownerUserId: request.auth?.isDevBypass ? null : request.auth?.userId,
        organizationId: request.auth?.isDevBypass ? null : request.auth?.organizationId,
        assetType: assetType as AssetType,
        locale,
        maxSuggestions,
        assetsPerQuery,
        autocompleteEnabled,
        mode
      });

      return reply.status(201).send(result);
    }
  );

  app.get("/api/research-runs", async (request) => {
    const query = request.query as { limit?: string };
    const limit = Number(query.limit ?? 20);
    return listResearchRuns(Number.isFinite(limit) ? limit : 20, request.auth);
  });

  app.get<{ Params: { id: string } }>(
    "/api/research-runs/:id",
    async (request, reply) => {
      const run = await getResearchRun(request.params.id, request.auth);

      if (!run) {
        return reply.status(404).send({
          error: "RESEARCH_NOT_FOUND"
        });
      }

      return run;
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/api/research-runs/:id",
    async (request, reply) => {
      try {
        const result = await deleteResearchRun(request.params.id, request.auth);
        if (!result) return reply.status(404).send({ error: "RESEARCH_NOT_FOUND" });
        await invalidateGlobalInsightsCache();
        return result;
      } catch (error) {
        if (error instanceof Error && error.name === "RESEARCH_ACTIVE") {
          return reply.status(409).send({
            error: "RESEARCH_ACTIVE",
            message: "Batalkan research yang sedang berjalan sebelum menghapusnya"
          });
        }
        request.log.error(
          { err: error, researchRunId: request.params.id },
          "Research delete failed"
        );
        return reply.status(500).send({
          error: "RESEARCH_DELETE_FAILED",
          message: "Research tidak dapat dihapus. Periksa log backend."
        });
      }
    }
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>(
    "/api/research-runs/:id/results",
    async (request, reply) => {
      const run = await getResearchRun(request.params.id, request.auth);

      if (!run) {
        return reply.status(404).send({
          error: "RESEARCH_NOT_FOUND"
        });
      }

      const limit = Number(request.query.limit ?? 50);
      const offset = Number(request.query.offset ?? 0);
      return getResearchResults(
        request.params.id,
        Number.isFinite(limit) ? limit : 50,
        Number.isFinite(offset) ? offset : 0
      );
    }
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>(
    "/api/research-runs/:id/keywords",
    async (request, reply) => {
      const run = await getResearchRun(request.params.id, request.auth);

      if (!run) {
        return reply.status(404).send({
          error: "RESEARCH_NOT_FOUND"
        });
      }

      const limit = Number(request.query.limit ?? 500);
      const offset = Number(request.query.offset ?? 0);
      return getResearchKeywords(
        request.params.id,
        Number.isFinite(limit) ? limit : 500,
        Number.isFinite(offset) ? offset : 0
      );
    }
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/research-runs/:id/events",
    async (request, reply) => {
      const run = await getResearchRun(request.params.id, request.auth);

      if (!run) {
        return reply.status(404).send({
          error: "RESEARCH_NOT_FOUND"
        });
      }

      const limit = Number(request.query.limit ?? 100);
      return listResearchEvents(request.params.id, Number.isFinite(limit) ? limit : 100);
    }
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/research-runs/:id/detail-log",
    async (request, reply) => {
      const run = await getResearchRun(request.params.id, request.auth);

      if (!run) {
        return reply.status(404).send({ error: "RESEARCH_NOT_FOUND" });
      }

      const limit = Number(request.query.limit ?? 100);
      return listResearchDetailLogs(
        request.params.id,
        Number.isFinite(limit) ? limit : 100
      );
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/research-runs/:id/stream",
    async (request, reply) => {
      const initialRun = await getResearchRun(request.params.id, request.auth);
      if (!initialRun) return reply.status(404).send({ error: "RESEARCH_NOT_FOUND" });

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "access-control-allow-origin": env.frontendOrigin,
        "access-control-allow-credentials": "true"
      });

      let closed = false;
      let lastState = "";
      let pollTimer: NodeJS.Timeout | undefined;
      let keepAliveTimer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        request.raw.off("close", cleanup);
      };

      const send = (event: string, payload: unknown) => {
        if (closed || reply.raw.destroyed) return;
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      const emitSnapshot = async (force = false) => {
        if (closed) return;
        try {
          const run = await getResearchRun(request.params.id, request.auth);
          if (!run) {
            send("error", { error: "RESEARCH_NOT_FOUND" });
            cleanup();
            reply.raw.end();
            return;
          }

          const state = [
            run.status,
            run.progressCompleted,
            run.errorMessage ?? "",
            run.completedAt?.getTime() ?? ""
          ].join("|");
          if (!force && state === lastState) return;
          lastState = state;

          const [events, detailLogs] = await Promise.all([
            listResearchEvents(request.params.id, 100),
            listResearchDetailLogs(request.params.id, 100)
          ]);
          send("snapshot", { run, events, detailLogs });

          if (["completed", "failed", "partial", "cancelled"].includes(run.status)) {
            send("complete", { status: run.status });
            cleanup();
            reply.raw.end();
          }
        } catch (error) {
          request.log.warn({ err: error, researchRunId: request.params.id }, "Research SSE update failed");
        }
      };

      request.raw.on("close", cleanup);
      keepAliveTimer = setInterval(() => {
        if (!closed && !reply.raw.destroyed) reply.raw.write(": keep-alive\n\n");
      }, 15_000);
      pollTimer = setInterval(() => { void emitSnapshot(); }, 2_000);
      void emitSnapshot(true);
    }
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/research-runs/:id/summary",
    async (request, reply) => {
      if (!await getResearchRun(request.params.id, request.auth)) {
        return reply.status(404).send({ error: "RESEARCH_NOT_FOUND" });
      }
      const summary = await getResearchInsights(
        request.params.id,
        Number(request.query.limit ?? 20)
      );

      if (!summary) {
        return reply.status(404).send({ error: "RESEARCH_NOT_FOUND" });
      }

      return summary;
    }
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/research-runs/:id/keyword-opportunities",
    async (request, reply) => {
      if (!await getResearchRun(request.params.id, request.auth)) {
        return reply.status(404).send({ error: "RESEARCH_NOT_FOUND" });
      }
      const opportunities = await getKeywordOpportunities(
        request.params.id,
        Number(request.query.limit ?? 50)
      );

      if (!opportunities) {
        return reply.status(404).send({ error: "RESEARCH_NOT_FOUND" });
      }

      return opportunities;
    }
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/research-runs/:id/top-assets",
    async (request, reply) => {
      if (!await getResearchRun(request.params.id, request.auth)) {
        return reply.status(404).send({ error: "RESEARCH_NOT_FOUND" });
      }
      const assets = await getTopAssets(
        request.params.id,
        Number(request.query.limit ?? 50)
      );

      if (!assets) {
        return reply.status(404).send({ error: "RESEARCH_NOT_FOUND" });
      }

      return assets;
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/research-runs/:id/ai-context",
    async (request, reply) => {
      if (!await getResearchRun(request.params.id, request.auth)) {
        return reply.status(404).send({ error: "RESEARCH_NOT_FOUND" });
      }
      const context = await getAiContext(request.params.id);

      if (!context) {
        return reply.status(404).send({ error: "RESEARCH_NOT_FOUND" });
      }

      return context;
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/research-runs/:id/cancel",
    async (request, reply) => {
      try {
        const run = await cancelResearchRun(request.params.id, request.auth);

        if (!run) {
          return reply.status(404).send({
            error: "RESEARCH_NOT_FOUND_OR_FINISHED"
          });
        }

        return run;
      } catch (error) {
        request.log.error(
          { err: error, researchRunId: request.params.id },
          "Research cancel failed"
        );
        return reply.status(500).send({
          error: "RESEARCH_CANCEL_FAILED",
          message: "Research tidak dapat dibatalkan. Periksa log backend."
        });
      }
    }
  );
}
