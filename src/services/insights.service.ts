import { asc, eq } from "drizzle-orm";
import {
  assetKeywords,
  assetObservations,
  assets,
  searchQueries,
  suggestions
} from "../db/schema";
import { getDatabase } from "../db/client";
import { getResearchRun } from "./research.service";

type SortMode = "downloads" | "relevance" | "recent";
export const SCORING_VERSION = "mvp-1";

interface SuggestionRow {
  suggestion: string;
  position: number;
}

interface KeywordRow {
  keyword: string;
  normalizedKeyword: string;
  assetId: string;
  source: string;
}

interface ObservationRow {
  assetId: string;
  externalId: string;
  title: string;
  assetUrl: string;
  thumbnailUrl: string | null;
  assetType: string;
  width: number | null;
  height: number | null;
  isPremium: boolean;
  query: string;
  sortMode: string;
  rank: number;
  resultCount: number | null;
}

export interface KeywordOpportunity {
  keyword: string;
  normalizedKeyword: string;
  source: string;
  autocompletePosition: number | null;
  suggestionFrequency: number;
  queryCount: number;
  assetCount: number;
  bestDownloadRank: number | null;
  averageDownloadRank: number | null;
  bestRecentRank: number | null;
  resultCount: number | null;
  demandScore: number;
  competitionScore: number;
  freshnessScore: number;
  consistencyScore: number;
  opportunityScore: number;
}

export interface AssetOpportunity {
  assetId: string;
  externalId: string;
  title: string;
  assetUrl: string;
  thumbnailUrl: string | null;
  assetType: string;
  width: number | null;
  height: number | null;
  isPremium: boolean;
  appearances: number;
  sortModes: string[];
  bestDownloadRank: number | null;
  bestRecentRank: number | null;
  bestRelevanceRank: number | null;
  keywordCount: number;
  assetScore: number;
}

export interface ResearchSummary {
  runId: string;
  scoringVersion: string;
  generatedAt: string;
  totals: {
    suggestions: number;
    queries: number;
    expectedQueries: number;
    uniqueAssets: number;
    keywords: number;
  };
  dataQuality: {
    queryCoveragePct: number;
    keywordCoveragePct: number;
    completenessScore: number;
    confidence: "low" | "medium" | "high";
    warnings: string[];
    downloadsAssets: number;
    assetsWithKeywords: number;
    missingKeywordAssets: number;
    resultCountsAvailable: number;
  };
  scores: {
    demandScore: number;
    competitionScore: number;
    freshnessScore: number;
    consistencyScore: number;
    opportunityScore: number;
  };
  topKeywords: KeywordOpportunity[];
  topAssets: AssetOpportunity[];
}

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function rankScore(rank: number | null) {
  if (!rank || rank < 1) return 0;
  return clamp(100 - ((rank - 1) / 99) * 100);
}

function ranksScore(ranks: number[]) {
  if (!ranks.length) return 0;
  const strongest = [...ranks].sort((a, b) => a - b).slice(0, 3);
  return round(strongest.reduce((sum, rank) => sum + rankScore(rank), 0) / strongest.length);
}

function competitionScore(resultCount: number | null) {
  if (!resultCount || resultCount < 1) return 0;
  // Lower result count means lower visible competition. Log scale prevents very
  // large Adobe result counts from flattening every score to zero.
  return round(clamp(100 - Math.log10(resultCount) * 14));
}

export function calculateOpportunityScore(input: {
  demandScore: number;
  freshnessScore: number;
  consistencyScore: number;
  competitionScore: number;
}) {
  return round(
    input.demandScore * 0.4 +
      input.freshnessScore * 0.2 +
      input.consistencyScore * 0.2 +
      input.competitionScore * 0.2
  );
}

async function loadResearchData(runId: string) {
  const database = getDatabase();
  const [suggestionRows, keywordRows, observationRows] = await Promise.all([
    database
      .select({ suggestion: suggestions.suggestion, position: suggestions.position })
      .from(suggestions)
      .where(eq(suggestions.researchRunId, runId))
      .orderBy(asc(suggestions.position)),
    database
      .select({
        keyword: assetKeywords.keyword,
        normalizedKeyword: assetKeywords.normalizedKeyword,
        assetId: assetKeywords.assetId,
        source: assetKeywords.source
      })
      .from(assetKeywords)
      .where(eq(assetKeywords.researchRunId, runId)),
    database
      .select({
        assetId: assets.id,
        externalId: assets.externalId,
        title: assets.title,
        assetUrl: assets.assetUrl,
        thumbnailUrl: assets.thumbnailUrl,
        assetType: assets.assetType,
        width: assets.width,
        height: assets.height,
        isPremium: assets.isPremium,
        query: searchQueries.query,
        sortMode: assetObservations.sortMode,
        rank: assetObservations.rank,
        resultCount: searchQueries.resultCount
      })
      .from(assetObservations)
      .innerJoin(assets, eq(assetObservations.assetId, assets.id))
      .innerJoin(searchQueries, eq(assetObservations.searchQueryId, searchQueries.id))
      .where(eq(assetObservations.researchRunId, runId))
  ]);

  return {
    suggestions: suggestionRows as SuggestionRow[],
    keywords: keywordRows as KeywordRow[],
    observations: observationRows as ObservationRow[]
  };
}

function buildKeywordOpportunities(
  suggestionsRows: SuggestionRow[],
  keywordRows: KeywordRow[],
  observations: ObservationRow[]
) {
  const candidates = new Map<string, {
    keyword: string;
    sources: Set<string>;
    positions: number[];
    suggestionFrequency: number;
    assetIds: Set<string>;
    queryNames: Set<string>;
    sortModes: Set<string>;
    downloadRanks: number[];
    recentRanks: number[];
    resultCounts: number[];
  }>();

  const ensure = (normalizedKeyword: string, keyword: string) => {
    const existing = candidates.get(normalizedKeyword);
    if (existing) return existing;
    const created = {
      keyword,
      sources: new Set<string>(),
      positions: [],
      suggestionFrequency: 0,
      assetIds: new Set<string>(),
      queryNames: new Set<string>(),
      sortModes: new Set<string>(),
      downloadRanks: [],
      recentRanks: [],
      resultCounts: []
    };
    candidates.set(normalizedKeyword, created);
    return created;
  };

  for (const row of suggestionsRows) {
    const normalized = row.suggestion.toLowerCase().replace(/\s+/g, " ").trim();
    const candidate = ensure(normalized, row.suggestion);
    candidate.sources.add("adobe_autocomplete");
    candidate.positions.push(row.position);
    candidate.suggestionFrequency += 1;
  }

  for (const row of keywordRows) {
    const candidate = ensure(row.normalizedKeyword, row.keyword);
    candidate.sources.add(row.source);
    candidate.assetIds.add(row.assetId);
  }

  const candidatesByQuery = new Map<string, Set<string>>();
  for (const row of suggestionsRows) {
    const normalized = row.suggestion.toLowerCase().replace(/\s+/g, " ").trim();
    const queryCandidates = candidatesByQuery.get(row.suggestion) ?? new Set<string>();
    queryCandidates.add(normalized);
    candidatesByQuery.set(row.suggestion, queryCandidates);
  }
  const candidatesByAsset = new Map<string, Set<string>>();
  for (const row of keywordRows) {
    const assetCandidates = candidatesByAsset.get(row.assetId) ?? new Set<string>();
    assetCandidates.add(row.normalizedKeyword);
    candidatesByAsset.set(row.assetId, assetCandidates);
  }

  for (const observation of observations) {
    const matchingCandidates = new Set([
      ...(candidatesByQuery.get(observation.query) ?? []),
      ...(candidatesByAsset.get(observation.assetId) ?? [])
    ]);
    for (const normalized of matchingCandidates) {
      const candidate = candidates.get(normalized);
      if (!candidate) continue;

      candidate.assetIds.add(observation.assetId);
      candidate.queryNames.add(observation.query);
      candidate.sortModes.add(observation.sortMode);
      if (observation.resultCount !== null) candidate.resultCounts.push(observation.resultCount);
      if (observation.sortMode === "downloads") candidate.downloadRanks.push(observation.rank);
      if (observation.sortMode === "recent") candidate.recentRanks.push(observation.rank);
    }
  }

  return [...candidates.entries()].map(([normalizedKeyword, candidate]): KeywordOpportunity => {
    const bestDownloadRank = candidate.downloadRanks.length ? Math.min(...candidate.downloadRanks) : null;
    const bestRecentRank = candidate.recentRanks.length ? Math.min(...candidate.recentRanks) : null;
    const demandScore = ranksScore(candidate.downloadRanks);
    const freshnessScore = ranksScore(candidate.recentRanks);
    const consistencyScore = round(
      (candidate.sortModes.size / 3) * 60 + clamp(candidate.queryNames.size / 3) * 40
    );
    const resultCount = candidate.resultCounts.length ? Math.min(...candidate.resultCounts) : null;
    const competition = competitionScore(resultCount);
    const opportunityScore = calculateOpportunityScore({
      demandScore,
      freshnessScore,
      consistencyScore,
      competitionScore: competition
    });

    return {
      keyword: candidate.keyword,
      normalizedKeyword,
      source: [...candidate.sources].join(", "),
      autocompletePosition: candidate.positions.length ? Math.min(...candidate.positions) : null,
      suggestionFrequency: candidate.suggestionFrequency,
      queryCount: candidate.queryNames.size,
      assetCount: candidate.assetIds.size,
      bestDownloadRank,
      averageDownloadRank: average(candidate.downloadRanks) === null ? null : round(average(candidate.downloadRanks) as number),
      bestRecentRank,
      resultCount,
      demandScore,
      competitionScore: competition,
      freshnessScore,
      consistencyScore,
      opportunityScore
    };
  }).sort((a, b) => b.opportunityScore - a.opportunityScore || (a.autocompletePosition ?? 999) - (b.autocompletePosition ?? 999));
}

function buildAssetOpportunities(observations: ObservationRow[], keywords: KeywordRow[]) {
  const grouped = new Map<string, {
    first: ObservationRow;
    appearances: number;
    sortModes: Set<string>;
    downloads: number[];
    recent: number[];
    relevance: number[];
  }>();

  for (const observation of observations) {
    const current = grouped.get(observation.assetId) ?? {
      first: observation,
      appearances: 0,
      sortModes: new Set<string>(),
      downloads: [],
      recent: [],
      relevance: []
    };
    current.appearances += 1;
    current.sortModes.add(observation.sortMode);
    if (observation.sortMode === "downloads") current.downloads.push(observation.rank);
    if (observation.sortMode === "recent") current.recent.push(observation.rank);
    if (observation.sortMode === "relevance") current.relevance.push(observation.rank);
    grouped.set(observation.assetId, current);
  }

  return [...grouped.values()].map((item): AssetOpportunity => {
    const bestDownloadRank = item.downloads.length ? Math.min(...item.downloads) : null;
    const bestRecentRank = item.recent.length ? Math.min(...item.recent) : null;
    const bestRelevanceRank = item.relevance.length ? Math.min(...item.relevance) : null;
    const keywordCount = new Set(
      keywords.filter((keyword) => keyword.assetId === item.first.assetId).map((keyword) => keyword.normalizedKeyword)
    ).size;
    const assetScore = round(
      rankScore(bestDownloadRank) * 0.6 +
      rankScore(bestRecentRank) * 0.2 +
      clamp((item.appearances / 3) * 100) * 0.2
    );

    return {
      assetId: item.first.assetId,
      externalId: item.first.externalId,
      title: item.first.title,
      assetUrl: item.first.assetUrl,
      thumbnailUrl: item.first.thumbnailUrl,
      assetType: item.first.assetType,
      width: item.first.width,
      height: item.first.height,
      isPremium: item.first.isPremium,
      appearances: item.appearances,
      sortModes: [...item.sortModes],
      bestDownloadRank,
      bestRecentRank,
      bestRelevanceRank,
      keywordCount,
      assetScore
    };
  }).sort((a, b) => b.assetScore - a.assetScore || (a.bestDownloadRank ?? 9999) - (b.bestDownloadRank ?? 9999));
}

export async function getResearchInsights(runId: string, limit = 20) {
  const run = await getResearchRun(runId);
  if (!run) return null;

  const data = await loadResearchData(runId);
  const keywordOpportunities = buildKeywordOpportunities(data.suggestions, data.keywords, data.observations);
  const assetOpportunities = buildAssetOpportunities(data.observations, data.keywords);
  const downloadAssets = new Set(
    data.observations.filter((observation) => observation.sortMode === "downloads").map((observation) => observation.assetId)
  );
  const assetsWithKeywords = new Set(data.keywords.map((keyword) => keyword.assetId));
  const uniqueQueries = new Set(data.observations.map((observation) => `${observation.query}\u001f${observation.sortMode}`));
  const expectedQueries = run.progressTotal || data.suggestions.length * 3;
  const resultCountsAvailable = new Set(
    data.observations.filter((observation) => observation.resultCount !== null).map((observation) => `${observation.query}\u001f${observation.sortMode}`)
  ).size;
  const queryCoveragePct = expectedQueries ? round(clamp((uniqueQueries.size / expectedQueries) * 100)) : 0;
  const keywordCoveragePct = downloadAssets.size ? round((assetsWithKeywords.size / downloadAssets.size) * 100) : 0;
  const completenessScore = round(
    queryCoveragePct * 0.55 +
      keywordCoveragePct * 0.25 +
      (expectedQueries ? clamp((resultCountsAvailable / expectedQueries) * 100) : 0) * 0.2
  );
  const confidence: ResearchSummary["dataQuality"]["confidence"] =
    completenessScore >= 85 && expectedQueries >= 9 ? "high" : completenessScore >= 60 ? "medium" : "low";
  const warnings: string[] = [];
  if (queryCoveragePct < 100) warnings.push("Sebagian query belum selesai diproses.");
  if (keywordCoveragePct < 80) warnings.push("Keyword detail belum tersedia untuk sebagian besar aset Downloads.");
  if (resultCountsAvailable < expectedQueries) warnings.push("Sebagian query tidak memiliki result count.");
  const topForScore = keywordOpportunities.slice(0, 10);
  const scoreAverage = (key: keyof Pick<KeywordOpportunity, "demandScore" | "competitionScore" | "freshnessScore" | "consistencyScore" | "opportunityScore">) =>
    topForScore.length ? round(topForScore.reduce((sum, item) => sum + item[key], 0) / topForScore.length) : 0;

  const summary: ResearchSummary = {
    runId,
    scoringVersion: SCORING_VERSION,
    generatedAt: new Date().toISOString(),
    totals: {
      suggestions: data.suggestions.length,
      queries: uniqueQueries.size,
      expectedQueries,
      uniqueAssets: new Set(data.observations.map((observation) => observation.assetId)).size,
      keywords: data.keywords.length
    },
    dataQuality: {
      queryCoveragePct,
      keywordCoveragePct,
      completenessScore,
      confidence,
      warnings,
      downloadsAssets: downloadAssets.size,
      assetsWithKeywords: [...assetsWithKeywords].filter((assetId) => downloadAssets.has(assetId)).length,
      missingKeywordAssets: [...downloadAssets].filter((assetId) => !assetsWithKeywords.has(assetId)).length,
      resultCountsAvailable
    },
    scores: {
      demandScore: scoreAverage("demandScore"),
      competitionScore: scoreAverage("competitionScore"),
      freshnessScore: scoreAverage("freshnessScore"),
      consistencyScore: scoreAverage("consistencyScore"),
      opportunityScore: scoreAverage("opportunityScore")
    },
    topKeywords: keywordOpportunities.slice(0, Math.min(Math.max(limit, 1), 500)),
    topAssets: assetOpportunities.slice(0, Math.min(Math.max(limit, 1), 500))
  };

  return summary;
}

export async function getKeywordOpportunities(runId: string, limit = 50) {
  const insights = await getResearchInsights(runId, limit);
  return insights?.topKeywords ?? null;
}

export async function getTopAssets(runId: string, limit = 50) {
  const insights = await getResearchInsights(runId, limit);
  return insights?.topAssets ?? null;
}

export async function getAiContext(runId: string) {
  const insights = await getResearchInsights(runId, 20);
  if (!insights) return null;
  const run = await getResearchRun(runId);

  return {
    schemaVersion: "1.0",
    scoringVersion: insights.scoringVersion,
    run: {
      id: insights.runId,
      seedKeyword: run?.seedKeyword,
      assetType: run?.assetType,
      locale: run?.locale
    },
    dataQuality: insights.dataQuality,
    scores: insights.scores,
    topKeywords: insights.topKeywords,
    topAssets: insights.topAssets,
    instructions: "Gunakan data sebagai sinyal peluang, bukan jaminan jumlah download aktual."
  };
}
