import type { FastifyInstance } from "fastify";
import { compareResearchRuns } from "../services/comparison.service";
import { getResearchRun } from "../services/research.service";

interface ComparisonQuery {
  firstRunId?: string;
  secondRunId?: string;
  limit?: string;
}

export async function comparisonRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ComparisonQuery }>("/api/research-comparisons", async (request, reply) => {
    const firstRunId = request.query.firstRunId?.trim();
    const secondRunId = request.query.secondRunId?.trim();
    if (!firstRunId || !secondRunId || firstRunId === secondRunId) {
      return reply.status(400).send({ error: "INVALID_COMPARISON", message: "Pilih dua research yang berbeda" });
    }
    const [firstRun, secondRun] = await Promise.all([
      getResearchRun(firstRunId, request.auth),
      getResearchRun(secondRunId, request.auth)
    ]);
    if (!firstRun || !secondRun) return reply.status(404).send({ error: "RESEARCH_NOT_FOUND" });
    const result = await compareResearchRuns(firstRunId, secondRunId, Number(request.query.limit ?? 100));
    if (!result) return reply.status(404).send({ error: "RESEARCH_NOT_FOUND" });
    return result;
  });
}
