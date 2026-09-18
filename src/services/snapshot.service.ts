import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  assetOpportunitySnapshots,
  assets,
  keywordOpportunitySnapshots,
  researchRuns
} from "../db/schema";
import { getDatabase } from "../db/client";
import {
  getResearchInsights,
  SCORING_VERSION,
  type AssetOpportunity,
  type KeywordOpportunity
} from "./insights.service";
import { getResearchRun, makeStableId } from "./research.service";
import { researchScopeCondition } from "./research.service";
import type { AuthContext } from "../auth";

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
    demandScore: item.downloadSignalScore ?? 0,
    competitionScore: item.lowCompetitionScore ?? 0,
    freshnessScore: item.freshnessSignalScore ?? 0,
    consistencyScore: item.crossSortScore ?? 0,
    opportunityScore: item.opportunityScore ?? 0,
    scoringVersion: SCORING_VERSION,
    scoreStatus: item.scoreStatus,
    rankLevel: item.level,
    observedAt: item.lastObservedAt ?? new Date()
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
    assetScore: item.assetScore ?? 0,
    scoringVersion: SCORING_VERSION,
    scoreStatus: item.scoreStatus,
    observedAt: item.lastObservedAt ?? new Date()
  }));

  for (const rows of chunk(keywordRows, 100)) {
    await database.insert(keywordOpportunitySnapshots).values(rows).onConflictDoUpdate({
      target: keywordOpportunitySnapshots.id,
      set: {
        displayKeyword: sql`excluded.display_keyword`, source: sql`excluded.source`,
        autocompletePosition: sql`excluded.autocomplete_position`, suggestionFrequency: sql`excluded.suggestion_frequency`,
        queryCount: sql`excluded.query_count`, assetCount: sql`excluded.asset_count`,
        bestDownloadRank: sql`excluded.best_download_rank`, averageDownloadRank: sql`excluded.average_download_rank`,
        bestRecentRank: sql`excluded.best_recent_rank`, resultCount: sql`excluded.result_count`,
        demandScore: sql`excluded.demand_score`, competitionScore: sql`excluded.competition_score`,
        freshnessScore: sql`excluded.freshness_score`, consistencyScore: sql`excluded.consistency_score`,
        opportunityScore: sql`excluded.opportunity_score`, scoringVersion: sql`excluded.scoring_version`,
        scoreStatus: sql`excluded.score_status`, rankLevel: sql`excluded.rank_level`, observedAt: sql`excluded.observed_at`
      }
    });
  }
  for (const rows of chunk(assetRows, 100)) {
    await database.insert(assetOpportunitySnapshots).values(rows).onConflictDoUpdate({
      target: assetOpportunitySnapshots.id,
      set: {
        appearances: sql`excluded.appearances`, bestDownloadRank: sql`excluded.best_download_rank`,
        bestRecentRank: sql`excluded.best_recent_rank`, bestRelevanceRank: sql`excluded.best_relevance_rank`,
        keywordCount: sql`excluded.keyword_count`, assetScore: sql`excluded.asset_score`,
        scoringVersion: sql`excluded.scoring_version`, scoreStatus: sql`excluded.score_status`, observedAt: sql`excluded.observed_at`
      }
    });
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
      database.select({
        researchRunId: keywordOpportunitySnapshots.researchRunId,
        scoringVersion: keywordOpportunitySnapshots.scoringVersion
      }).from(keywordOpportunitySnapshots)
    ]);
    const existingRuns = new Set(existing.filter((row) => row.scoringVersion === SCORING_VERSION).map((row) => row.researchRunId));
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

function recencyWeight(observedAt: Date, now = Date.now()) {
  const ageDays = Math.max(0, (now - observedAt.getTime()) / 86_400_000);
  if (ageDays <= 7) return 1;
  if (ageDays <= 30) return 0.75;
  if (ageDays <= 90) return 0.5;
  return 0.25;
}

function weightedAverage(items: Array<{ value: number; observedAt: Date }>) {
  if (!items.length) return null;
  const weighted = items.reduce((total, item) => total + item.value * recencyWeight(item.observedAt), 0);
  const weight = items.reduce((total, item) => total + recencyWeight(item.observedAt), 0);
  return weight ? weighted / weight : null;
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
  trend: "up" | "stable" | "down" | "unknown";
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
  totals: { researchRuns: number; keywords: number; assets: number; snapshots: number };
  keywords: GlobalKeywordInsight[];
  assets: GlobalAssetInsight[];
}

export interface GlobalAssetInsight {
  assetId: string;
  externalId: string;
  title: string;
  assetUrl: string;
  thumbnailUrl: string | null;
  assetType: string;
  locale: string;
  category: string;
  researchCount: number;
  effectiveObservationCount: number;
  weightedScore: number | null;
  confidence: "low" | "medium" | "high";
  bestDownloadRank: number | null;
  bestRelevanceRank: number | null;
  bestRecentRank: number | null;
  firstObservedAt: Date;
  lastObservedAt: Date;
}

export async function getGlobalInsights(options: { assetType?: string; locale?: string; category?: string; limit?: number } = {}, auth?: AuthContext | null) {
  await ensureSnapshotBackfill();
  const database = getDatabase();
  const conditions = [];
  conditions.push(eq(keywordOpportunitySnapshots.scoringVersion, SCORING_VERSION));
  conditions.push(inArray(keywordOpportunitySnapshots.scoreStatus, ["provisional", "scored"]));
  const scope = researchScopeCondition(auth);
  if (scope) conditions.push(scope);
  if (options.assetType && options.assetType !== "all") conditions.push(eq(keywordOpportunitySnapshots.assetType, options.assetType));
  if (options.locale && options.locale !== "all") conditions.push(eq(keywordOpportunitySnapshots.locale, options.locale));
  if (options.category && options.category !== "all") conditions.push(eq(keywordOpportunitySnapshots.category, options.category));
  const rows = await database
    .select({ snapshot: keywordOpportunitySnapshots })
    .from(keywordOpportunitySnapshots)
    .innerJoin(researchRuns, eq(keywordOpportunitySnapshots.researchRunId, researchRuns.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(keywordOpportunitySnapshots.observedAt));
  const latestPerWindow = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const day = row.snapshot.observedAt.toISOString().slice(0, 10);
    const key = [row.snapshot.normalizedKeyword, row.snapshot.assetType, row.snapshot.locale, row.snapshot.category, day].join("\u001f");
    const existing = latestPerWindow.get(key);
    if (!existing || existing.snapshot.observedAt < row.snapshot.observedAt) latestPerWindow.set(key, row);
  }
  const snapshotRows = [...latestPerWindow.values()].map((row) => row.snapshot);

  const grouped = new Map<string, typeof snapshotRows>();
  for (const row of snapshotRows) {
    const scopeKey = [row.normalizedKeyword, row.assetType, row.locale, row.category].join("\u001f");
    const current = grouped.get(scopeKey) ?? [];
    current.push(row);
    grouped.set(scopeKey, current);
  }

  const keywords = [...grouped.values()].map((items): GlobalKeywordInsight => {
    const sorted = [...items].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
    const normalizedKeyword = sorted[0]?.normalizedKeyword ?? "";
    const byDay = new Map<string, number[]>();
    for (const item of sorted) {
      const day = item.observedAt.toISOString().slice(0, 10);
      const scores = byDay.get(day) ?? [];
      scores.push(item.opportunityScore);
      byDay.set(day, scores);
    }
    const dailyScores = [...byDay.entries()]
      .map(([day, scores]) => ({ day, score: avg(scores) ?? 0 }))
      .sort((a, b) => b.day.localeCompare(a.day));
    const latestScore = dailyScores[0]?.score ?? null;
    const priorScore = dailyScores[1]?.score ?? null;
    const trend: GlobalKeywordInsight["trend"] = latestScore === null || priorScore === null
      ? "unknown"
      : latestScore > priorScore + 4 ? "up" : latestScore < priorScore - 4 ? "down" : "stable";
    const researchIds = new Set(items.map((item) => item.researchRunId));
    const averageOpportunityScore = avg(items.map((item) => item.opportunityScore));
    const globalOpportunityScore = round(weightedAverage(items.map((item) => ({ value: item.opportunityScore, observedAt: item.observedAt }))));
    const observationSpanDays = sorted.length > 1
      ? Math.floor((sorted[0].observedAt.getTime() - sorted[sorted.length - 1].observedAt.getTime()) / 86_400_000)
      : 0;

    return {
      keyword: sorted[0]?.displayKeyword ?? normalizedKeyword,
      normalizedKeyword,
      assetTypes: [...new Set(items.map((item) => item.assetType))],
      locales: [...new Set(items.map((item) => item.locale))],
      categories: [...new Set(items.map((item) => item.category))],
      researchCount: researchIds.size,
      snapshotCount: items.length,
      confidence: dailyScores.length >= 4 && observationSpanDays >= 14 ? "high" : dailyScores.length >= 2 ? "medium" : "low",
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

  const assetConditions = [
    eq(assetOpportunitySnapshots.scoringVersion, SCORING_VERSION),
    eq(assetOpportunitySnapshots.scoreStatus, "scored"),
    gt(assetOpportunitySnapshots.assetScore, 0)
  ];
  if (scope) assetConditions.push(scope);
  if (options.assetType && options.assetType !== "all") assetConditions.push(eq(researchRuns.assetType, options.assetType));
  if (options.locale && options.locale !== "all") assetConditions.push(eq(researchRuns.locale, options.locale));
  if (options.category && options.category !== "all") assetConditions.push(eq(researchRuns.category, options.category));
  const assetRows = await database.select({
    snapshot: assetOpportunitySnapshots,
    asset: assets,
    locale: researchRuns.locale,
    category: researchRuns.category,
    runAssetType: researchRuns.assetType
  }).from(assetOpportunitySnapshots)
    .innerJoin(assets, eq(assetOpportunitySnapshots.assetId, assets.id))
    .innerJoin(researchRuns, eq(assetOpportunitySnapshots.researchRunId, researchRuns.id))
    .where(and(...assetConditions))
    .orderBy(desc(assetOpportunitySnapshots.observedAt));
  const effectiveAssets = new Map<string, (typeof assetRows)[number]>();
  for (const row of assetRows) {
    const day = row.snapshot.observedAt.toISOString().slice(0, 10);
    const key = [row.asset.id, row.runAssetType, row.locale, row.category, day].join("\u001f");
    if (!effectiveAssets.has(key)) effectiveAssets.set(key, row);
  }
  const assetsByScope = new Map<string, Array<(typeof assetRows)[number]>>();
  for (const row of effectiveAssets.values()) {
    const key = [row.asset.id, row.runAssetType, row.locale, row.category].join("\u001f");
    const current = assetsByScope.get(key) ?? [];
    current.push(row); assetsByScope.set(key, current);
  }
  const globalAssets = [...assetsByScope.values()].map((items): GlobalAssetInsight => {
    const sorted = [...items].sort((a, b) => b.snapshot.observedAt.getTime() - a.snapshot.observedAt.getTime());
    const first = sorted[0];
    const researchIds = new Set(items.map((item) => item.snapshot.researchRunId));
    const spanDays = sorted.length > 1 ? Math.floor((sorted[0].snapshot.observedAt.getTime() - sorted[sorted.length - 1].snapshot.observedAt.getTime()) / 86_400_000) : 0;
    const minimumRank = (values: Array<number | null>) => {
      const available = values.filter((value): value is number => value !== null);
      return available.length ? Math.min(...available) : null;
    };
    return {
      assetId: first.asset.id, externalId: first.asset.externalId, title: first.asset.title,
      assetUrl: first.asset.assetUrl, thumbnailUrl: first.asset.thumbnailUrl, assetType: first.runAssetType,
      locale: first.locale, category: first.category, researchCount: researchIds.size,
      effectiveObservationCount: items.length,
      weightedScore: round(weightedAverage(items.map((item) => ({ value: item.snapshot.assetScore, observedAt: item.snapshot.observedAt })))),
      confidence: items.length >= 4 && spanDays >= 14 ? "high" : items.length >= 2 ? "medium" : "low",
      bestDownloadRank: minimumRank(items.map((item) => item.snapshot.bestDownloadRank)),
      bestRelevanceRank: minimumRank(items.map((item) => item.snapshot.bestRelevanceRank)),
      bestRecentRank: minimumRank(items.map((item) => item.snapshot.bestRecentRank)),
      firstObservedAt: sorted[sorted.length - 1].snapshot.observedAt,
      lastObservedAt: first.snapshot.observedAt
    };
  }).sort((a, b) => (b.weightedScore ?? 0) - (a.weightedScore ?? 0) || b.researchCount - a.researchCount);

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return {
    generatedAt: new Date().toISOString(),
    filters: { assetType: options.assetType ?? "all", locale: options.locale ?? "all", category: options.category ?? "all" },
    totals: {
      researchRuns: new Set(snapshotRows.map((row) => row.researchRunId)).size,
      keywords: grouped.size,
      assets: assetsByScope.size,
      snapshots: snapshotRows.length
    },
    keywords: keywords.slice(0, limit),
    assets: globalAssets.slice(0, limit)
  } satisfies GlobalInsights;
}

export async function getGlobalAiContext(options: { assetType?: string; locale?: string; category?: string } = {}, auth?: AuthContext | null) {
  const insights = await getGlobalInsights({ ...options, limit: 100 }, auth);
  const database = getDatabase();
  const conditions = [];
  conditions.push(eq(assetOpportunitySnapshots.scoringVersion, SCORING_VERSION));
  conditions.push(eq(assetOpportunitySnapshots.scoreStatus, "scored"));
  conditions.push(gt(assetOpportunitySnapshots.assetScore, 0));
  const scope = researchScopeCondition(auth);
  if (scope) conditions.push(scope);
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
