import type { FastifyInstance } from "fastify";
import { getGlobalInsights } from "../services/snapshot.service";

interface InsightsQuery {
  assetType?: string;
  locale?: string;
  category?: string;
  limit?: string;
}

export async function insightsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: InsightsQuery }>("/api/insights/export.csv", async (request, reply) => {
    const result = await getGlobalInsights({
      assetType: request.query.assetType,
      locale: request.query.locale,
      category: request.query.category,
      limit: 200
    }, request.auth);
    const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const header = ["global_rank", "keyword", "global_level", "global_label", "global_opportunity_score", "average_opportunity_score", "confidence", "trend", "research_count", "average_download_rank", "average_result_count", "asset_count", "asset_types", "locales", "sources"];
    const rows = result.keywords.map((item) => [
      item.globalRank,
      item.keyword,
      item.level,
      item.label,
      item.globalOpportunityScore,
      item.averageOpportunityScore,
      item.confidence,
      item.trend,
      item.researchCount,
      item.averageDownloadRank,
      item.averageResultCount,
      item.assetCount,
      item.assetTypes.join("|"),
      item.locales.join("|"),
      item.sources.join("|")
    ]);
    return reply.type("text/csv; charset=utf-8").send([header, ...rows].map((row) => row.map(escape).join(",")).join("\n"));
  });

  app.get<{ Querystring: InsightsQuery }>("/api/insights", async (request) => {
    return getGlobalInsights({
      assetType: request.query.assetType,
      locale: request.query.locale,
      category: request.query.category,
      limit: Number(request.query.limit ?? 50)
    }, request.auth);
  });

  app.get<{ Querystring: InsightsQuery }>("/api/insights/keywords", async (request) => {
    const result = await getGlobalInsights({
      assetType: request.query.assetType,
      locale: request.query.locale,
      category: request.query.category,
      limit: Number(request.query.limit ?? 50)
    }, request.auth);
    return result.keywords;
  });
}
