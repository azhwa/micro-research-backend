import { and, desc, eq } from "drizzle-orm";
import {
  assetOpportunitySnapshots,
  assets,
  keywordOpportunitySnapshots,
  researchRuns
} from "../db/schema";
import { getDatabase } from "../db/client";
import {
  getResearchInsights,
  type AssetOpportunity,
  type KeywordOpportunity
} from "./insights.service";
import { getResearchRun, makeStableId } from "./research.service";

const SNAPSHOT_KEYWORD_LIMIT = 500;
let backfillPromise: Promise<void> | null = null;

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

export async function persistResearchSnapshots(researchRunId: string) {
  const run = await getResearchRun(researchRunId);
  if (!run) return { keywords: 0, assets: 0 };

  const insights = await getResearchInsights(researchRunId, SNAPSHOT_KEYWORD_LIMIT);
  if (!insights) return { keywords: 0, assets: 0 };
  const database = getDatabase();

  const keywordRows = insights.topKeywords.map((item: KeywordOpportunity) => ({
    id: makeStableId("keyword-snapshot", researchRunId, item.normalizedKeyword, run.assetType, run.locale),
    researchRunId,
    category: run.category,
    normalizedKeyword: item.normalizedKeyword,
    displayKeyword: item.keyword,
    assetType: run.assetType,
    locale: run.locale,
    source: item.source,
    autocompletePosition: item.autocompletePosition,
    suggestionFrequency: item.suggestionFrequency,
    queryCount: item.queryCount,
    assetCount: item.assetCount,
    bestDownloadRank: item.bestDownloadRank,
    averageDownloadRank: item.averageDownloadRank,
    bestRecentRank: item.bestRecentRank,
    resultCount: item.resultCount,
    demandScore: item.demandScore,
    competitionScore: item.competitionScore,
    freshnessScore: item.freshnessScore,
    consistencyScore: item.consistencyScore,
    opportunityScore: item.opportunityScore
  }));
  const assetRows = insights.topAssets.map((item: AssetOpportunity) => ({
    id: makeStableId("asset-snapshot", researchRunId, item.assetId),
    researchRunId,
    assetId: item.assetId,
    appearances: item.appearances,
    bestDownloadRank: item.bestDownloadRank,
    bestRecentRank: item.bestRecentRank,
    bestRelevanceRank: item.bestRelevanceRank,
    keywordCount: item.keywordCount,
    assetScore: item.assetScore
  }));

  for (const rows of chunk(keywordRows, 100)) {
    await database.insert(keywordOpportunitySnapshots).values(rows).onConflictDoNothing();
  }
  for (const rows of chunk(assetRows, 100)) {
    await database.insert(assetOpportunitySnapshots).values(rows).onConflictDoNothing();
  }

  return { keywords: keywordRows.length, assets: assetRows.length };
}

async function ensureSnapshotBackfill() {
  if (backfillPromise) return backfillPromise;
  backfillPromise = (async () => {
    const database = getDatabase();
    const [runs, existing] = await Promise.all([
      database.select({
        id: researchRuns.id,
        status: researchRuns.status,
        progressTotal: researchRuns.progressTotal,
        progressCompleted: researchRuns.progressCompleted
      }).from(researchRuns).where(eq(researchRuns.status, "completed")),
      database.select({ researchRunId: keywordOpportunitySnapshots.researchRunId }).from(keywordOpportunitySnapshots)
    ]);
    const existingRuns = new Set(existing.map((row) => row.researchRunId));
    for (const run of runs) {
      if (existingRuns.has(run.id)) continue;
      if (run.progressTotal > 0 && run.progressCompleted < run.progressTotal) continue;
      await persistResearchSnapshots(run.id);
    }
  })().finally(() => { backfillPromise = null; });
  return backfillPromise;
}

function avg(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function round(value: number | null) {
  return value === null ? null : Math.round(value * 10) / 10;
}

export interface GlobalKeywordInsight {
  keyword: string;
  normalizedKeyword: string;
  assetTypes: string[];
  locales: string[];
  categories: string[];
  researchCount: number;
  snapshotCount: number;
  confidence: "low" | "medium" | "high";
  trend: "up" | "stable" | "down";
  averageOpportunityScore: number | null;
  globalOpportunityScore: number | null;
  averageDemandScore: number | null;
  averageCompetitionScore: number | null;
  averageFreshnessScore: number | null;
  averageConsistencyScore: number | null;
  averageDownloadRank: number | null;
  averageResultCount: number | null;
  assetCount: number;
  sources: string[];
  firstObservedAt: Date;
  lastObservedAt: Date;
}

export interface GlobalInsights {
  generatedAt: string;
  filters: { assetType: string; locale: string; category: string };
  totals: { researchRuns: number; keywords: number; snapshots: number };
  keywords: GlobalKeywordInsight[];
}

export async function getGlobalInsights(options: { assetType?: string; locale?: string; category?: string; limit?: number } = {}, auth?: unknown) {
  await ensureSnapshotBackfill();
  const database = getDatabase();
  void auth;
  const conditions = [];
  if (options.assetType && options.assetType !== "all") conditions.push(eq(keywordOpportunitySnapshots.assetType, options.assetType));
  if (options.locale && options.locale !== "all") conditions.push(eq(keywordOpportunitySnapshots.locale, options.locale));
  if (options.category && options.category !== "all") conditions.push(eq(keywordOpportunitySnapshots.category, options.category));
  const rows = await database
    .select({ snapshot: keywordOpportunitySnapshots })
    .from(keywordOpportunitySnapshots)
    .innerJoin(researchRuns, eq(keywordOpportunitySnapshots.researchRunId, researchRuns.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(keywordOpportunitySnapshots.observedAt));
  const snapshotRows = rows.map((row) => row.snapshot);

  const grouped = new Map<string, typeof snapshotRows>();
  for (const row of snapshotRows) {
    const current = grouped.get(row.normalizedKeyword) ?? [];
    current.push(row);
    grouped.set(row.normalizedKeyword, current);
  }

  const keywords = [...grouped.entries()].map(([normalizedKeyword, items]): GlobalKeywordInsight => {
    const sorted = [...items].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
    const recent = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
    const older = sorted.slice(Math.max(1, Math.ceil(sorted.length / 2)));
    const recentScore = avg(recent.map((item) => item.opportunityScore)) ?? 0;
    const olderScore = avg(older.map((item) => item.opportunityScore));
    const trend: GlobalKeywordInsight["trend"] = olderScore === null || recentScore > olderScore + 4 ? "up" : recentScore < olderScore - 4 ? "down" : "stable";
    const researchIds = new Set(items.map((item) => item.researchRunId));
    const averageOpportunityScore = avg(items.map((item) => item.opportunityScore));
    const globalOpportunityScore = averageOpportunityScore === null ? null : Math.round(Math.min(100, averageOpportunityScore + Math.min(15, Math.max(0, researchIds.size - 1) * 5)) * 10) / 10;

    return {
      keyword: sorted[0]?.displayKeyword ?? normalizedKeyword,
      normalizedKeyword,
      assetTypes: [...new Set(items.map((item) => item.assetType))],
      locales: [...new Set(items.map((item) => item.locale))],
      categories: [...new Set(items.map((item) => item.category))],
      researchCount: researchIds.size,
      snapshotCount: items.length,
      confidence: researchIds.size >= 4 ? "high" : researchIds.size >= 2 ? "medium" : "low",
      trend,
      averageOpportunityScore: round(averageOpportunityScore),
      globalOpportunityScore,
      averageDemandScore: round(avg(items.map((item) => item.demandScore))),
      averageCompetitionScore: round(avg(items.map((item) => item.competitionScore))),
      averageFreshnessScore: round(avg(items.map((item) => item.freshnessScore))),
      averageConsistencyScore: round(avg(items.map((item) => item.consistencyScore))),
      averageDownloadRank: round(avg(items.map((item) => item.averageDownloadRank).filter((value): value is number => value !== null))),
      averageResultCount: round(avg(items.map((item) => item.resultCount).filter((value): value is number => value !== null))),
      assetCount: Math.max(...items.map((item) => item.assetCount), 0),
      sources: [...new Set(items.flatMap((item) => item.source.split(", ")))],
      firstObservedAt: sorted[sorted.length - 1]?.observedAt ?? new Date(),
      lastObservedAt: sorted[0]?.observedAt ?? new Date()
    };
  }).sort((a, b) => (b.globalOpportunityScore ?? 0) - (a.globalOpportunityScore ?? 0) || b.researchCount - a.researchCount);

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return {
    generatedAt: new Date().toISOString(),
    filters: { assetType: options.assetType ?? "all", locale: options.locale ?? "all", category: options.category ?? "all" },
    totals: {
      researchRuns: new Set(snapshotRows.map((row) => row.researchRunId)).size,
      keywords: grouped.size,
      snapshots: snapshotRows.length
    },
    keywords: keywords.slice(0, limit)
  } satisfies GlobalInsights;
}

export async function getGlobalAiContext(options: { assetType?: string; locale?: string; category?: string } = {}) {
  const insights = await getGlobalInsights({ ...options, limit: 100 });
  const database = getDatabase();
  const conditions = [];
  if (options.assetType && options.assetType !== "all") conditions.push(eq(researchRuns.assetType, options.assetType));
  if (options.locale && options.locale !== "all") conditions.push(eq(researchRuns.locale, options.locale));
  if (options.category && options.category !== "all") conditions.push(eq(researchRuns.category, options.category));

  const rows = await database
    .select({
      externalId: assets.externalId,
      platform: assets.platform,
      assetType: assets.assetType,
      title: assets.title,
      assetUrl: assets.assetUrl,
      thumbnailUrl: assets.thumbnailUrl,
      appearances: assetOpportunitySnapshots.appearances,
      assetScore: assetOpportunitySnapshots.assetScore,
      keywordCount: assetOpportunitySnapshots.keywordCount,
      bestDownloadRank: assetOpportunitySnapshots.bestDownloadRank,
      researchRunId: assetOpportunitySnapshots.researchRunId,
      seedKeyword: researchRuns.seedKeyword
    })
    .from(assetOpportunitySnapshots)
    .innerJoin(assets, eq(assetOpportunitySnapshots.assetId, assets.id))
    .innerJoin(researchRuns, eq(assetOpportunitySnapshots.researchRunId, researchRuns.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(assetOpportunitySnapshots.assetScore))
    .limit(300);

  const grouped = new Map<string, {
    externalId: string;
    platform: string;
    assetType: string;
    title: string;
    assetUrl: string;
    thumbnailUrl: string | null;
    appearances: number;
    bestAssetScore: number;
    keywordCount: number;
    bestDownloadRank: number | null;
    researchRunIds: Set<string>;
    seedKeywords: Set<string>;
  }>();

  for (const row of rows) {
    const key = `${row.platform}:${row.externalId}`;
    const current = grouped.get(key) ?? {
      externalId: row.externalId,
      platform: row.platform,
      assetType: row.assetType,
      title: row.title,
      assetUrl: row.assetUrl,
      thumbnailUrl: row.thumbnailUrl,
      appearances: 0,
      bestAssetScore: 0,
      keywordCount: 0,
      bestDownloadRank: null,
      researchRunIds: new Set<string>(),
      seedKeywords: new Set<string>()
    };
    current.appearances += row.appearances;
    current.bestAssetScore = Math.max(current.bestAssetScore, row.assetScore);
    current.keywordCount = Math.max(current.keywordCount, row.keywordCount);
    current.bestDownloadRank = current.bestDownloadRank === null
      ? row.bestDownloadRank
      : row.bestDownloadRank === null ? current.bestDownloadRank : Math.min(current.bestDownloadRank, row.bestDownloadRank);
    current.researchRunIds.add(row.researchRunId);
    current.seedKeywords.add(row.seedKeyword);
    grouped.set(key, current);
  }

  const topAssets = [...grouped.values()]
    .sort((a, b) => b.researchRunIds.size - a.researchRunIds.size || b.bestAssetScore - a.bestAssetScore || b.appearances - a.appearances)
    .slice(0, 100)
    .map((item) => ({
      externalId: item.externalId,
      platform: item.platform,
      assetType: item.assetType,
      title: item.title,
      assetUrl: item.assetUrl,
      thumbnailUrl: item.thumbnailUrl,
      appearances: item.appearances,
      researchCount: item.researchRunIds.size,
      bestAssetScore: round(item.bestAssetScore),
      keywordCount: item.keywordCount,
      bestDownloadRank: item.bestDownloadRank,
      seenForKeywords: [...item.seedKeywords].slice(0, 10)
    }));

  return {
    schemaVersion: "global-1.0",
    scope: "global",
    generatedAt: new Date().toISOString(),
    filters: {
      assetType: options.assetType ?? "all",
      locale: options.locale ?? "all",
      category: options.category ?? "all"
    },
    totals: insights.totals,
    topKeywords: insights.keywords,
    topAssets,
    instructions: "Gunakan seluruh data sebagai sinyal peluang. Jangan mengklaim jumlah download aktual atau menjamin penjualan."
  };
}
