import { asc, eq } from "drizzle-orm";
import { assetKeywords, assetObservations, assets, assetOpportunitySnapshots, keywordOpportunitySnapshots, searchQueries, suggestions } from "../db/schema";
import { getDatabase } from "../db/client";
import { getResearchRun } from "./research.service";
import { dataAgeStatus, lowCompetitionScore, normalizeKeyword, rankSignal, type ResultCountQualifier } from "./research-metrics";

type SortMode = "downloads" | "relevance" | "recent";
type Confidence = "low" | "medium" | "high";
type ScoreStatus = "scored" | "provisional" | "discovery" | "insufficient_data" | "not_directly_researched";
type KeywordLevel = 0 | 1 | 2 | 3 | 4 | 5;
export const SCORING_VERSION = "candidate-v2";

interface SuggestionRow { suggestion: string; position: number; source: string; isSeed: boolean; autocompletePrefix: string | null; observedAt: Date }
interface KeywordRow { keyword: string; normalizedKeyword: string; assetId: string; source: string; position: number; observedAt: Date }
interface QueryRow { id: string; query: string; normalizedQuery: string; sortMode: string; resultCount: number | null; resultCountQualifier: string; requestedLimit: number; collectedCount: number; collectionStatus: string; isComplete: boolean; observedAt: Date }
interface ObservationRow { assetId: string; externalId: string; title: string; assetUrl: string; thumbnailUrl: string | null; assetType: string; width: number | null; height: number | null; isPremium: boolean; query: string; normalizedQuery: string; sortMode: string; rank: number; requestedLimit: number; observedAt: Date }

export interface KeywordOpportunity {
  keyword: string; normalizedKeyword: string; source: string; isSeed: boolean;
  researchStatus: "directly_researched" | "discovered"; scoreStatus: ScoreStatus;
  rank: number | null; score: number | null; opportunityScore: number | null;
  level: KeywordLevel; label: string; indicator: string; confidence: Confidence;
  autocompletePosition: number | null; suggestionFrequency: number; queryCount: number;
  assetCount: number; supportingAssetCount: number; enrichedSampleCount: number;
  bestDownloadRank: number | null; averageDownloadRank: number | null;
  bestRecentRank: number | null; bestRelevanceRank: number | null;
  resultCount: number | null; resultCountQualifier: ResultCountQualifier;
  downloadSignalScore: number | null; lowCompetitionScore: number | null;
  relevanceSignalScore: number | null; freshnessSignalScore: number | null;
  crossSortScore: number | null; autocompleteScore: number | null;
  evidenceQueries: string[]; firstObservedAt: Date | null; lastObservedAt: Date | null;
}

export interface AssetOpportunity {
  assetId: string; externalId: string; title: string; assetUrl: string; thumbnailUrl: string | null;
  assetType: string; width: number | null; height: number | null; isPremium: boolean; query: string;
  appearances: number; sortModes: string[]; sortCoverage: number; evaluatedSortCount: number;
  crossSortLabel: "strong_consensus" | "multi_signal" | "single_signal" | "partial_evidence";
  sortStatus: Record<SortMode, "found" | "not_observed_in_sample" | "not_collected" | "failed">;
  evidence: string[]; ranks: Record<SortMode, number | null>;
  bestDownloadRank: number | null; bestRecentRank: number | null; bestRelevanceRank: number | null;
  keywordCount: number; assetScore: number | null; scoreStatus: "scored" | "insufficient_data";
  firstObservedAt: Date | null; lastObservedAt: Date | null;
}

export interface ResearchSummary {
  runId: string; scoringVersion: string; generatedAt: string;
  dataAge: { firstObservedAt: Date | null; lastObservedAt: Date | null; dataAgeDays: number | null; status: "fresh" | "aging" | "stale" | "refresh_recommended" | "unknown"; refreshRecommended: boolean };
  totals: { suggestions: number; queries: number; expectedQueries: number; uniqueAssets: number; keywords: number; scoredKeywords: number };
  dataQuality: { queryCoveragePct: number; keywordCoveragePct: number; completenessScore: number; confidence: Confidence; warnings: string[]; downloadsAssets: number; observedAssets: number; assetsWithKeywords: number; missingKeywordAssets: number; resultCountsAvailable: number };
  scores: { demandScore: number | null; competitionScore: number | null; freshnessScore: number | null; consistencyScore: number | null; opportunityScore: number | null };
  topKeywords: KeywordOpportunity[]; topAssets: AssetOpportunity[];
}

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const round = (value: number) => Math.round(value * 10) / 10;
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const averageNullable = (values: Array<number | null>) => {
  const available = values.filter((value): value is number => value !== null);
  return available.length ? round(average(available) as number) : null;
};
const minDate = (values: Date[]) => values.length ? new Date(Math.min(...values.map((value) => value.getTime()))) : null;
const maxDate = (values: Date[]) => values.length ? new Date(Math.max(...values.map((value) => value.getTime()))) : null;

function keywordLevel(score: number | null): { level: KeywordLevel; label: string; indicator: string } {
  if (score === null) return { level: 0, label: "Data belum cukup", indicator: "outline" };
  if (score < 20) return { level: 1, label: "Weak", indicator: "gray" };
  if (score < 40) return { level: 2, label: "Low", indicator: "amber" };
  if (score < 60) return { level: 3, label: "Normal", indicator: "green" };
  if (score < 80) return { level: 4, label: "Good", indicator: "blue" };
  return { level: 5, label: "Excellent", indicator: "violet" };
}

export function calculateKeywordSignalScore(input: { downloadSignalScore: number; lowCompetitionScore: number; relevanceSignalScore: number; freshnessSignalScore: number; crossSortScore: number; autocompleteScore: number }) {
  return round(input.downloadSignalScore * 0.25 + input.lowCompetitionScore * 0.25 + input.relevanceSignalScore * 0.15 + input.freshnessSignalScore * 0.1 + input.crossSortScore * 0.15 + input.autocompleteScore * 0.1);
}

export function calculateDiscoveryScore(input: { rankSignalScore: number; frequencyScore: number; crossSortScore: number; keywordPositionScore: number }) {
  return round(input.rankSignalScore * 0.35 + input.frequencyScore * 0.25 + input.crossSortScore * 0.2 + input.keywordPositionScore * 0.2);
}

/** Kept for compatibility with existing imports. New insights use calculateKeywordSignalScore. */
export function calculateOpportunityScore(input: { demandScore: number; freshnessScore: number; consistencyScore: number; competitionScore: number }) {
  return round(input.demandScore * 0.4 + input.freshnessScore * 0.2 + input.consistencyScore * 0.2 + input.competitionScore * 0.2);
}

async function loadResearchData(runId: string) {
  const database = getDatabase();
  const [suggestionRows, keywordRows, queryRows, observationRows] = await Promise.all([
    database.select({ suggestion: suggestions.suggestion, position: suggestions.position, source: suggestions.source, isSeed: suggestions.isSeed, autocompletePrefix: suggestions.autocompletePrefix, observedAt: suggestions.observedAt }).from(suggestions).where(eq(suggestions.researchRunId, runId)).orderBy(asc(suggestions.position)),
    database.select({ keyword: assetKeywords.keyword, normalizedKeyword: assetKeywords.normalizedKeyword, assetId: assetKeywords.assetId, source: assetKeywords.source, position: assetKeywords.position, observedAt: assetKeywords.observedAt }).from(assetKeywords).where(eq(assetKeywords.researchRunId, runId)),
    database.select({ id: searchQueries.id, query: searchQueries.query, sortMode: searchQueries.sortMode, resultCount: searchQueries.resultCount, resultCountQualifier: searchQueries.resultCountQualifier, requestedLimit: searchQueries.requestedLimit, collectedCount: searchQueries.collectedCount, collectionStatus: searchQueries.collectionStatus, isComplete: searchQueries.isComplete, observedAt: searchQueries.observedAt }).from(searchQueries).where(eq(searchQueries.researchRunId, runId)),
    database.select({ assetId: assets.id, externalId: assets.externalId, title: assets.title, assetUrl: assets.assetUrl, thumbnailUrl: assets.thumbnailUrl, assetType: assets.assetType, width: assets.width, height: assets.height, isPremium: assets.isPremium, query: searchQueries.query, sortMode: assetObservations.sortMode, rank: assetObservations.rank, requestedLimit: searchQueries.requestedLimit, observedAt: assetObservations.observedAt }).from(assetObservations).innerJoin(assets, eq(assetObservations.assetId, assets.id)).innerJoin(searchQueries, eq(assetObservations.searchQueryId, searchQueries.id)).where(eq(assetObservations.researchRunId, runId))
  ]);
  return {
    suggestions: suggestionRows as SuggestionRow[],
    keywords: keywordRows as KeywordRow[],
    queries: queryRows.map((row) => ({ ...row, normalizedQuery: normalizeKeyword(row.query) })) as QueryRow[],
    observations: observationRows.map((row) => ({ ...row, normalizedQuery: normalizeKeyword(row.query) })) as ObservationRow[]
  };
}

function buildKeywordOpportunities(seedKeyword: string, suggestionsRows: SuggestionRow[], keywordRows: KeywordRow[], queries: QueryRow[], observations: ObservationRow[]) {
  const candidates = new Map<string, { keyword: string; sources: Set<string>; positions: number[]; prefixes: Set<string>; isSeed: boolean; assetIds: Set<string>; dates: Date[] }>();
  const ensure = (normalized: string, keyword: string) => {
    const existing = candidates.get(normalized);
    if (existing) return existing;
    const created = { keyword, sources: new Set<string>(), positions: [] as number[], prefixes: new Set<string>(), isSeed: normalized === normalizeKeyword(seedKeyword), assetIds: new Set<string>(), dates: [] as Date[] };
    candidates.set(normalized, created);
    return created;
  };
  for (const row of suggestionsRows) {
    const normalized = normalizeKeyword(row.suggestion);
    if (!normalized) continue;
    const candidate = ensure(normalized, row.suggestion);
    candidate.sources.add(row.source);
    candidate.isSeed ||= row.isSeed;
    if (row.source === "adobe_autocomplete" || row.source === "autocomplete") {
      candidate.positions.push(row.position);
      candidate.prefixes.add(row.autocompletePrefix ?? "legacy");
    }
    candidate.dates.push(row.observedAt);
  }
  for (const row of keywordRows) {
    const normalized = normalizeKeyword(row.normalizedKeyword || row.keyword);
    if (!normalized) continue;
    const candidate = ensure(normalized, row.keyword);
    candidate.sources.add(row.source);
    candidate.assetIds.add(row.assetId);
    candidate.dates.push(row.observedAt);
  }
  for (const row of queries) {
    if (!row.normalizedQuery) continue;
    const candidate = ensure(row.normalizedQuery, row.query);
    candidate.sources.add("direct_search");
    candidate.dates.push(row.observedAt);
  }
  const enrichedAssetIds = new Set(keywordRows.map((row) => row.assetId));
  const all = [...candidates.entries()].map(([normalizedKeyword, candidate]): KeywordOpportunity => {
    const directQueries = queries.filter((row) => row.normalizedQuery === normalizedKeyword && row.isComplete && row.collectionStatus === "completed");
    const supportingObservations = observations.filter((row) => candidate.assetIds.has(row.assetId));
    const evaluatedModes = new Set(directQueries.map((row) => row.sortMode));
    const ranks = (mode: SortMode) => supportingObservations.filter((row) => row.sortMode === mode).map((row) => row.rank);
    const downloadRanks = ranks("downloads");
    const relevanceRanks = ranks("relevance");
    const recentRanks = ranks("recent");
    const modeRankSignal = (mode: SortMode) => {
      const values = supportingObservations
        .filter((row) => row.sortMode === mode)
        .map((row) => rankSignal(row.rank, row.requestedLimit || 100))
        .filter((value): value is number => value !== null);
      return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
    };
    const bestDownloadRank = downloadRanks.length ? Math.min(...downloadRanks) : null;
    const bestRelevanceRank = relevanceRanks.length ? Math.min(...relevanceRanks) : null;
    const bestRecentRank = recentRanks.length ? Math.min(...recentRanks) : null;
    const averageRankSignal = (mode: SortMode, values: number[]) => {
      const limits = observations.filter((row) => row.sortMode === mode && candidate.assetIds.has(row.assetId)).map((row) => row.requestedLimit || 100);
      const scores = values.map((rank, index) => rankSignal(rank, limits[index] ?? 100)).filter((value): value is number => value !== null);
      return scores.length ? round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : null;
    };
    const downloadRankQuality = averageRankSignal("downloads", downloadRanks);
    const supportingDownloadAssets = new Set(supportingObservations.filter((row) => row.sortMode === "downloads").map((row) => row.assetId));
    const supportCoverage = enrichedAssetIds.size ? (supportingDownloadAssets.size / enrichedAssetIds.size) * 100 : null;
    const downloadScore = downloadRankQuality === null || supportCoverage === null ? null : round(supportCoverage * 0.6 + downloadRankQuality * 0.4);
    const relevanceScore = averageRankSignal("relevance", relevanceRanks);
    const freshnessScore = averageRankSignal("recent", recentRanks);
    const resultRows = directQueries.filter((row) => row.resultCount !== null);
    const resultCount = resultRows.length ? Math.max(...resultRows.map((row) => row.resultCount as number)) : null;
    const qualifier: ResultCountQualifier = resultRows.some((row) => row.resultCountQualifier === "at_least")
      ? "at_least"
      : resultRows.some((row) => row.resultCountQualifier === "approximate") ? "approximate" : resultRows.length ? "displayed" : "unknown";
    const competition = lowCompetitionScore(resultCount, qualifier);
    const modesByAssetAndQuery = new Map<string, Set<string>>();
    for (const observation of supportingObservations) {
      const key = `${observation.assetId}\u001f${observation.normalizedQuery}`;
      const modes = modesByAssetAndQuery.get(key) ?? new Set<string>();
      modes.add(observation.sortMode); modesByAssetAndQuery.set(key, modes);
    }
    const coverageValues = [...modesByAssetAndQuery.values()].map((modes) => (modes.size / 3) * 100);
    const crossScore = evaluatedModes.size === 3 && coverageValues.length
      ? round(coverageValues.reduce((sum, value) => sum + value, 0) / coverageValues.length)
      : null;
    const autocompletePosition = candidate.positions.length ? Math.min(...candidate.positions) : null;
    const autocompleteScore = autocompletePosition === null ? null : rankSignal(autocompletePosition, 10);
    const directlyResearched = directQueries.length > 0;
    const allSignalsAvailable = evaluatedModes.size === 3 && downloadScore !== null && relevanceScore !== null && freshnessScore !== null && competition !== null && crossScore !== null && autocompleteScore !== null;
    const score = allSignalsAvailable ? calculateKeywordSignalScore({ downloadSignalScore: downloadScore, lowCompetitionScore: competition, relevanceSignalScore: relevanceScore, freshnessSignalScore: freshnessScore, crossSortScore: crossScore, autocompleteScore }) : null;
    const discoveryModesByAsset = new Map<string, Set<string>>();
    for (const observation of supportingObservations) {
      const modes = discoveryModesByAsset.get(observation.assetId) ?? new Set<string>();
      modes.add(observation.sortMode);
      discoveryModesByAsset.set(observation.assetId, modes);
    }
    const discoveryRankScore = (() => {
      const weighted = [
        { value: modeRankSignal("downloads"), weight: 0.5 },
        { value: modeRankSignal("relevance"), weight: 0.3 },
        { value: modeRankSignal("recent"), weight: 0.2 }
      ].filter((part): part is { value: number; weight: number } => part.value !== null);
      const totalWeight = weighted.reduce((sum, part) => sum + part.weight, 0);
      return totalWeight ? round(weighted.reduce((sum, part) => sum + part.value * part.weight, 0) / totalWeight) : null;
    })();
    const discoveryFrequencyScore = enrichedAssetIds.size
      ? round(clamp((candidate.assetIds.size / enrichedAssetIds.size) * 100))
      : null;
    const discoveryCrossSortScore = candidate.assetIds.size
      ? round([...candidate.assetIds].reduce((sum, assetId) => sum + ((discoveryModesByAsset.get(assetId)?.size ?? 0) / 3) * 100, 0) / candidate.assetIds.size)
      : null;
    const discoveryPositionRows = keywordRows
      .filter((row) => normalizeKeyword(row.normalizedKeyword || row.keyword) === normalizedKeyword)
      .map((row) => row.position <= 5 ? 100 : row.position <= 15 ? 50 : 15);
    const discoveryPositionScore = discoveryPositionRows.length
      ? round(discoveryPositionRows.reduce((sum, value) => sum + value, 0) / discoveryPositionRows.length)
      : null;
    const discoveryScore = !directlyResearched && discoveryRankScore !== null && discoveryFrequencyScore !== null && discoveryCrossSortScore !== null && discoveryPositionScore !== null
      ? calculateDiscoveryScore({ rankSignalScore: discoveryRankScore, frequencyScore: discoveryFrequencyScore, crossSortScore: discoveryCrossSortScore, keywordPositionScore: discoveryPositionScore })
      : null;
    const finalScore = directlyResearched ? score : discoveryScore;
    const scoreStatus: ScoreStatus = directlyResearched
      ? score !== null ? "provisional" : "insufficient_data"
      : discoveryScore !== null ? "discovery" : "not_directly_researched";
    const level = keywordLevel(finalScore);
    const evidenceDates = [...candidate.dates, ...directQueries.map((row) => row.observedAt), ...supportingObservations.map((row) => row.observedAt)];
    return {
      keyword: candidate.keyword, normalizedKeyword, source: [...candidate.sources].join(", "), isSeed: candidate.isSeed,
      researchStatus: directlyResearched ? "directly_researched" : "discovered", scoreStatus, rank: null, score: finalScore, opportunityScore: finalScore,
      level: level.level, label: scoreStatus === "discovery" ? "Discovery evidence" : scoreStatus === "not_directly_researched" ? "Belum diriset langsung" : level.label, indicator: level.indicator,
      confidence: finalScore === null ? "low" : supportingObservations.length >= 30 ? "high" : "medium",
      autocompletePosition, suggestionFrequency: candidate.prefixes.size, queryCount: new Set(directQueries.map((row) => row.query)).size,
      assetCount: candidate.assetIds.size, supportingAssetCount: candidate.assetIds.size, enrichedSampleCount: enrichedAssetIds.size,
      bestDownloadRank, averageDownloadRank: averageNullable(downloadRanks), bestRecentRank, bestRelevanceRank,
      resultCount, resultCountQualifier: qualifier, downloadSignalScore: downloadScore, lowCompetitionScore: competition,
      relevanceSignalScore: relevanceScore, freshnessSignalScore: freshnessScore, crossSortScore: crossScore, autocompleteScore,
      evidenceQueries: [...new Set(supportingObservations.map((row) => row.query))], firstObservedAt: minDate(evidenceDates), lastObservedAt: maxDate(evidenceDates)
    };
  });
  // Keep the researched seed visible before the much larger related-tag set.
  // Otherwise hundreds of discovered tags can push the seed past the API/UI limit.
  all.sort((a, b) => a.isSeed !== b.isSeed ? (a.isSeed ? -1 : 1) : (a.score !== null || b.score !== null) ? (b.score ?? -1) - (a.score ?? -1) : b.supportingAssetCount - a.supportingAssetCount || (a.autocompletePosition ?? 999) - (b.autocompletePosition ?? 999));
  let rank = 0;
  for (const item of all) if (!item.isSeed && item.score !== null) item.rank = ++rank;
  return all;
}

function buildAssetOpportunities(queries: QueryRow[], observations: ObservationRow[], keywords: KeywordRow[]) {
  const totalAppearances = new Map<string, number>();
  for (const row of observations) totalAppearances.set(row.assetId, (totalAppearances.get(row.assetId) ?? 0) + 1);
  const grouped = new Map<string, { first: ObservationRow; rows: ObservationRow[] }>();
  for (const row of observations) {
    const key = `${row.assetId}\u001f${row.normalizedQuery}`;
    const current = grouped.get(key) ?? { first: row, rows: [] };
    current.rows.push(row); grouped.set(key, current);
  }
  const candidates = [...grouped.values()].map((group): AssetOpportunity => {
    const queryRows = queries.filter((row) => row.normalizedQuery === group.first.normalizedQuery && row.isComplete && row.collectionStatus === "completed");
    const evaluatedModes = new Set(queryRows.map((row) => row.sortMode));
    const bestRank = (mode: SortMode) => { const values = group.rows.filter((row) => row.sortMode === mode).map((row) => row.rank); return values.length ? Math.min(...values) : null; };
    const bestDownloadRank = bestRank("downloads"), bestRelevanceRank = bestRank("relevance"), bestRecentRank = bestRank("recent");
    const foundModes = new Set(group.rows.map((row) => row.sortMode));
    const coverage = foundModes.size;
    const statusFor = (mode: SortMode): AssetOpportunity["sortStatus"][SortMode] => {
      if (foundModes.has(mode)) return "found";
      const query = queries.find((row) => row.normalizedQuery === group.first.normalizedQuery && row.sortMode === mode);
      if (!query) return "not_collected";
      if (query.collectionStatus === "failed") return "failed";
      return query.isComplete ? "not_observed_in_sample" : "not_collected";
    };
    const sortStatus: AssetOpportunity["sortStatus"] = { downloads: statusFor("downloads"), relevance: statusFor("relevance"), recent: statusFor("recent") };
    const crossSortLabel: AssetOpportunity["crossSortLabel"] = coverage === 3 && evaluatedModes.size === 3 ? "strong_consensus" : coverage >= 2 ? "multi_signal" : coverage === 1 && evaluatedModes.size === 3 ? "single_signal" : "partial_evidence";
    const evidence: string[] = [];
    if (bestDownloadRank !== null && bestDownloadRank <= 10) evidence.push("top_download_signal");
    if (bestRecentRank !== null && bestRecentRank <= 10) evidence.push("fresh_contender");
    if (crossSortLabel !== "partial_evidence") evidence.push(crossSortLabel);
    const requested = (mode: SortMode) => queryRows.find((row) => row.sortMode === mode)?.requestedLimit || 100;
    const downloadScore = rankSignal(bestDownloadRank, requested("downloads"));
    const relevanceScore = rankSignal(bestRelevanceRank, requested("relevance"));
    const recentScore = rankSignal(bestRecentRank, requested("recent"));
    const assetScore = evaluatedModes.size === 3 && downloadScore !== null
      ? round(downloadScore * 0.55 + (relevanceScore ?? 0) * 0.25 + (recentScore ?? 0) * 0.2)
      : null;
    const dates = group.rows.map((row) => row.observedAt);
    return {
      assetId: group.first.assetId, externalId: group.first.externalId, title: group.first.title, assetUrl: group.first.assetUrl,
      thumbnailUrl: group.first.thumbnailUrl, assetType: group.first.assetType, width: group.first.width, height: group.first.height,
      isPremium: group.first.isPremium, query: group.first.query, appearances: totalAppearances.get(group.first.assetId) ?? group.rows.length,
      sortModes: [...foundModes], sortCoverage: coverage, evaluatedSortCount: evaluatedModes.size, crossSortLabel, sortStatus, evidence,
      ranks: { downloads: bestDownloadRank, relevance: bestRelevanceRank, recent: bestRecentRank }, bestDownloadRank, bestRecentRank, bestRelevanceRank,
      keywordCount: new Set(keywords.filter((row) => row.assetId === group.first.assetId).map((row) => row.normalizedKeyword)).size,
      assetScore, scoreStatus: assetScore === null ? "insufficient_data" : "scored", firstObservedAt: minDate(dates), lastObservedAt: maxDate(dates)
    };
  });
  const bestByAsset = new Map<string, AssetOpportunity>();
  for (const item of candidates) {
    const current = bestByAsset.get(item.assetId);
    if (!current || (item.assetScore ?? -1) > (current.assetScore ?? -1) || ((item.assetScore ?? -1) === (current.assetScore ?? -1) && (item.bestDownloadRank ?? 9999) < (current.bestDownloadRank ?? 9999))) bestByAsset.set(item.assetId, item);
  }
  return [...bestByAsset.values()].sort((a, b) => (b.assetScore ?? -1) - (a.assetScore ?? -1) || (a.bestDownloadRank ?? 9999) - (b.bestDownloadRank ?? 9999));
}

export async function getResearchInsights(runId: string, limit = 20) {
  const run = await getResearchRun(runId);
  if (!run) return null;
  const data = await loadResearchData(runId);
  if (!data.queries.length && !data.observations.length && !data.suggestions.length) {
    const snapshotInsights = await getSnapshotResearchInsights(run, limit);
    if (snapshotInsights) return snapshotInsights;
  }
  const keywordOpportunities = buildKeywordOpportunities(run.seedKeyword, data.suggestions, data.keywords, data.queries, data.observations);
  const assetOpportunities = buildAssetOpportunities(data.queries, data.observations, data.keywords);
  const completedQueries = data.queries.filter((row) => row.isComplete && row.collectionStatus === "completed");
  const downloadAssets = new Set(data.observations.filter((row) => row.sortMode === "downloads").map((row) => row.assetId));
  const observedAssets = new Set(data.observations.map((row) => row.assetId));
  const assetsWithKeywords = new Set(data.keywords.map((row) => row.assetId));
  const expectedQueries = run.progressTotal || data.suggestions.length * (run.mode === "fast" ? 1 : 3);
  const queryCoveragePct = expectedQueries ? round(clamp((completedQueries.length / expectedQueries) * 100)) : 0;
  const keywordCoveragePct = observedAssets.size ? round(([...assetsWithKeywords].filter((id) => observedAssets.has(id)).length / observedAssets.size) * 100) : 0;
  const resultCountsAvailable = completedQueries.filter((row) => row.resultCount !== null).length;
  const completenessScore = round(queryCoveragePct * 0.55 + keywordCoveragePct * 0.25 + (expectedQueries ? clamp((resultCountsAvailable / expectedQueries) * 100) : 0) * 0.2);
  const confidence: Confidence = completenessScore >= 85 && expectedQueries >= 9 ? "high" : completenessScore >= 60 ? "medium" : "low";
  const warnings: string[] = [];
  if (queryCoveragePct < 100) warnings.push("Sebagian query belum selesai atau gagal diproses.");
  if (keywordCoveragePct < 80) warnings.push("Keyword detail belum tersedia untuk sebagian besar asset yang diamati.");
  if (resultCountsAvailable < completedQueries.length) warnings.push("Sebagian query tidak memiliki result count yang dapat dibaca.");
  if (run.mode === "fast") warnings.push("Mode Fast hanya mengamati Downloads; cross-sort dan score penuh belum tersedia.");
  const dates = [...data.queries.map((row) => row.observedAt), ...data.observations.map((row) => row.observedAt)];
  const firstObservedAt = minDate(dates), lastObservedAt = maxDate(dates), age = dataAgeStatus(firstObservedAt);
  const scoredKeywords = keywordOpportunities.filter((item) => item.score !== null && !item.isSeed);
  return {
    runId, scoringVersion: SCORING_VERSION, generatedAt: new Date().toISOString(),
    dataAge: { firstObservedAt, lastObservedAt, dataAgeDays: age.ageDays, status: age.status, refreshRecommended: age.refreshRecommended },
    totals: { suggestions: data.suggestions.length, queries: completedQueries.length, expectedQueries, uniqueAssets: new Set(data.observations.map((row) => row.assetId)).size, keywords: data.keywords.length, scoredKeywords: scoredKeywords.length },
    dataQuality: { queryCoveragePct, keywordCoveragePct, completenessScore, confidence, warnings, downloadsAssets: downloadAssets.size, observedAssets: observedAssets.size, assetsWithKeywords: [...assetsWithKeywords].filter((id) => observedAssets.has(id)).length, missingKeywordAssets: [...observedAssets].filter((id) => !assetsWithKeywords.has(id)).length, resultCountsAvailable },
    scores: { demandScore: averageNullable(scoredKeywords.map((item) => item.downloadSignalScore)), competitionScore: averageNullable(scoredKeywords.map((item) => item.lowCompetitionScore)), freshnessScore: averageNullable(scoredKeywords.map((item) => item.freshnessSignalScore)), consistencyScore: averageNullable(scoredKeywords.map((item) => item.crossSortScore)), opportunityScore: averageNullable(scoredKeywords.map((item) => item.score)) },
    topKeywords: keywordOpportunities.slice(0, Math.min(Math.max(limit, 1), 500)), topAssets: assetOpportunities.slice(0, Math.min(Math.max(limit, 1), 500))
  } satisfies ResearchSummary;
}

async function getSnapshotResearchInsights(run: Awaited<ReturnType<typeof getResearchRun>>, limit: number): Promise<ResearchSummary | null> {
  if (!run) return null;
  const database = getDatabase();
  const [keywordRows, assetRows] = await Promise.all([
    database.select().from(keywordOpportunitySnapshots).where(eq(keywordOpportunitySnapshots.researchRunId, run.id)),
    database
      .select({ snapshot: assetOpportunitySnapshots, asset: assets })
      .from(assetOpportunitySnapshots)
      .innerJoin(assets, eq(assetOpportunitySnapshots.assetId, assets.id))
      .where(eq(assetOpportunitySnapshots.researchRunId, run.id))
  ]);
  if (!keywordRows.length && !assetRows.length) return null;

  const seed = normalizeKeyword(run.seedKeyword);
  const keywordOpportunities: KeywordOpportunity[] = keywordRows.map((row) => {
    const scoreStatus: ScoreStatus = row.scoreStatus === "discovery"
      ? "discovery"
      : row.scoreStatus === "provisional" || row.scoreStatus === "scored"
        ? row.scoreStatus
        : "insufficient_data";
    const level = keywordLevel(row.opportunityScore);
    const isSeed = row.normalizedKeyword === seed;
    return {
      keyword: row.displayKeyword,
      normalizedKeyword: row.normalizedKeyword,
      source: row.source,
      isSeed,
      researchStatus: isSeed ? "directly_researched" : "discovered",
      scoreStatus,
      rank: null,
      score: row.opportunityScore,
      opportunityScore: row.opportunityScore,
      level: row.rankLevel as KeywordLevel,
      label: scoreStatus === "discovery" ? "Discovery evidence" : level.label,
      indicator: level.indicator,
      confidence: "medium",
      autocompletePosition: row.autocompletePosition,
      suggestionFrequency: row.suggestionFrequency,
      queryCount: row.queryCount,
      assetCount: row.assetCount,
      supportingAssetCount: row.assetCount,
      enrichedSampleCount: 0,
      bestDownloadRank: row.bestDownloadRank,
      averageDownloadRank: row.averageDownloadRank,
      bestRecentRank: row.bestRecentRank,
      bestRelevanceRank: null,
      resultCount: row.resultCount,
      resultCountQualifier: "unknown",
      downloadSignalScore: row.demandScore,
      lowCompetitionScore: row.competitionScore,
      relevanceSignalScore: null,
      freshnessSignalScore: row.freshnessScore,
      crossSortScore: row.consistencyScore,
      autocompleteScore: null,
      evidenceQueries: [],
      firstObservedAt: row.observedAt,
      lastObservedAt: row.observedAt
    };
  });
  keywordOpportunities.sort((a, b) => a.isSeed !== b.isSeed
    ? (a.isSeed ? -1 : 1)
    : (b.opportunityScore ?? -1) - (a.opportunityScore ?? -1));
  let rank = 0;
  for (const item of keywordOpportunities) if (!item.isSeed && item.score !== null) item.rank = ++rank;

  const assetOpportunities: AssetOpportunity[] = assetRows.map(({ snapshot, asset }) => {
    const ranks = { downloads: snapshot.bestDownloadRank, relevance: snapshot.bestRelevanceRank, recent: snapshot.bestRecentRank };
    const foundModes = (Object.entries(ranks) as Array<[SortMode, number | null]>).filter(([, value]) => value !== null).map(([mode]) => mode);
    const coverage = foundModes.length;
    const crossSortLabel: AssetOpportunity["crossSortLabel"] = coverage === 3
      ? "strong_consensus"
      : coverage === 2 ? "multi_signal"
        : coverage === 1 ? "single_signal" : "partial_evidence";
    const evidence: string[] = [];
    if (snapshot.bestDownloadRank !== null && snapshot.bestDownloadRank <= 10) evidence.push("top_download_signal");
    if (snapshot.bestRecentRank !== null && snapshot.bestRecentRank <= 10) evidence.push("fresh_contender");
    if (crossSortLabel !== "partial_evidence") evidence.push(crossSortLabel);
    const sortStatus = {
      downloads: snapshot.bestDownloadRank === null ? "not_observed_in_sample" : "found",
      relevance: snapshot.bestRelevanceRank === null ? "not_observed_in_sample" : "found",
      recent: snapshot.bestRecentRank === null ? "not_observed_in_sample" : "found"
    } as AssetOpportunity["sortStatus"];
    return {
      assetId: asset.id,
      externalId: asset.externalId,
      title: asset.title,
      assetUrl: asset.assetUrl,
      thumbnailUrl: asset.thumbnailUrl,
      assetType: asset.assetType,
      width: asset.width,
      height: asset.height,
      isPremium: asset.isPremium,
      query: run.seedKeyword,
      appearances: snapshot.appearances,
      sortModes: foundModes,
      sortCoverage: coverage,
      evaluatedSortCount: 3,
      crossSortLabel,
      sortStatus,
      evidence,
      ranks,
      bestDownloadRank: snapshot.bestDownloadRank,
      bestRecentRank: snapshot.bestRecentRank,
      bestRelevanceRank: snapshot.bestRelevanceRank,
      keywordCount: snapshot.keywordCount,
      assetScore: snapshot.assetScore,
      scoreStatus: snapshot.scoreStatus === "scored" ? "scored" as const : "insufficient_data" as const,
      firstObservedAt: snapshot.observedAt,
      lastObservedAt: snapshot.observedAt
    };
  }).sort((a, b) => (b.assetScore ?? -1) - (a.assetScore ?? -1));

  const dates = [...keywordRows.map((row) => row.observedAt), ...assetRows.map(({ snapshot }) => snapshot.observedAt)];
  const age = dataAgeStatus(minDate(dates));
  const scoredKeywords = keywordOpportunities.filter((item) => item.score !== null && !item.isSeed);
  const expectedQueries = run.progressTotal || 0;
  const complete = run.status === "completed";
  const warnings = ["Data mentah sudah dibersihkan; tampilan ini memakai snapshot scoring."];
  return {
    runId: run.id,
    scoringVersion: SCORING_VERSION,
    generatedAt: new Date().toISOString(),
    dataAge: { firstObservedAt: minDate(dates), lastObservedAt: maxDate(dates), dataAgeDays: age.ageDays, status: age.status, refreshRecommended: age.refreshRecommended },
    totals: { suggestions: keywordRows.length, queries: complete ? expectedQueries : 0, expectedQueries, uniqueAssets: new Set(assetRows.map(({ snapshot }) => snapshot.assetId)).size, keywords: keywordRows.length, scoredKeywords: scoredKeywords.length },
    dataQuality: { queryCoveragePct: complete ? 100 : 0, keywordCoveragePct: 100, completenessScore: complete ? 100 : 50, confidence: complete ? "medium" : "low", warnings, downloadsAssets: assetRows.length, observedAssets: assetRows.length, assetsWithKeywords: assetRows.filter(({ snapshot }) => snapshot.keywordCount > 0).length, missingKeywordAssets: assetRows.filter(({ snapshot }) => snapshot.keywordCount === 0).length, resultCountsAvailable: 0 },
    scores: { demandScore: averageNullable(scoredKeywords.map((item) => item.downloadSignalScore)), competitionScore: averageNullable(scoredKeywords.map((item) => item.lowCompetitionScore)), freshnessScore: averageNullable(scoredKeywords.map((item) => item.freshnessSignalScore)), consistencyScore: averageNullable(scoredKeywords.map((item) => item.crossSortScore)), opportunityScore: averageNullable(scoredKeywords.map((item) => item.score)) },
    topKeywords: keywordOpportunities.slice(0, Math.min(Math.max(limit, 1), 500)),
    topAssets: assetOpportunities.slice(0, Math.min(Math.max(limit, 1), 500))
  } satisfies ResearchSummary;
}

export async function getKeywordOpportunities(runId: string, limit = 50) { return (await getResearchInsights(runId, limit))?.topKeywords ?? null; }
export async function getTopAssets(runId: string, limit = 50) { return (await getResearchInsights(runId, limit))?.topAssets ?? null; }
export async function getAiContext(runId: string) {
  const insights = await getResearchInsights(runId, 20);
  if (!insights) return null;
  const run = await getResearchRun(runId);
  return { schemaVersion: "2.0", scoringVersion: insights.scoringVersion, run: { id: insights.runId, seedKeyword: run?.seedKeyword, assetType: run?.assetType, locale: run?.locale }, dataAge: insights.dataAge, dataQuality: insights.dataQuality, scores: insights.scores, topKeywords: insights.topKeywords, topAssets: insights.topAssets, instructions: "Gunakan data sebagai sinyal observasi. Jangan mengklaim jumlah download, upload date, atau jaminan penjualan. Keyword tanpa pencarian langsung memiliki discovery score, bukan market score." };
}
