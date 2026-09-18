import { getResearchRun } from "./research.service";
import { getResearchInsights } from "./insights.service";

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function metric(first: number | null, second: number | null) {
  return {
    first,
    second,
    delta: first === null || second === null ? null : round(second - first)
  };
}

export async function compareResearchRuns(firstRunId: string, secondRunId: string, limit = 100) {
  const [firstRun, secondRun, firstInsights, secondInsights] = await Promise.all([
    getResearchRun(firstRunId),
    getResearchRun(secondRunId),
    getResearchInsights(firstRunId, 500),
    getResearchInsights(secondRunId, 500)
  ]);
  if (!firstRun || !secondRun || !firstInsights || !secondInsights) return null;

  const firstByKeyword = new Map(firstInsights.topKeywords.map((item) => [item.normalizedKeyword, item]));
  const secondByKeyword = new Map(secondInsights.topKeywords.map((item) => [item.normalizedKeyword, item]));
  const keys = new Set([...firstByKeyword.keys(), ...secondByKeyword.keys()]);
  const keywordChanges = [...keys].map((normalizedKeyword) => {
    const first = firstByKeyword.get(normalizedKeyword);
    const second = secondByKeyword.get(normalizedKeyword);
    const firstScore = first?.opportunityScore ?? null;
    const secondScore = second?.opportunityScore ?? null;
    const delta = firstScore === null || secondScore === null ? null : round(secondScore - firstScore);
    const state = first && second ? (Math.abs(delta ?? 0) < 4 ? "stable" : "changed") : first ? "lost" : "new";
    return {
      keyword: second?.keyword ?? first?.keyword ?? normalizedKeyword,
      normalizedKeyword,
      state,
      firstScore,
      secondScore,
      delta,
      firstRank: first?.bestDownloadRank ?? null,
      secondRank: second?.bestDownloadRank ?? null,
      source: second?.source ?? first?.source ?? ""
    };
  }).sort((a, b) => Math.abs(b.delta ?? (b.secondScore ?? 0)) - Math.abs(a.delta ?? (a.firstScore ?? 0)));

  const firstAssetIds = new Set(firstInsights.topAssets.map((item) => item.assetId));
  const secondAssetIds = new Set(secondInsights.topAssets.map((item) => item.assetId));
  const overlap = [...firstAssetIds].filter((assetId) => secondAssetIds.has(assetId)).length;
  const union = new Set([...firstAssetIds, ...secondAssetIds]).size;

  return {
    generatedAt: new Date().toISOString(),
    firstRun: { id: firstRun.id, seedKeyword: firstRun.seedKeyword, category: firstRun.category, assetType: firstRun.assetType, locale: firstRun.locale, status: firstRun.status },
    secondRun: { id: secondRun.id, seedKeyword: secondRun.seedKeyword, category: secondRun.category, assetType: secondRun.assetType, locale: secondRun.locale, status: secondRun.status },
    metrics: {
      opportunityScore: metric(firstInsights.scores.opportunityScore, secondInsights.scores.opportunityScore),
      demandScore: metric(firstInsights.scores.demandScore, secondInsights.scores.demandScore),
      competitionScore: metric(firstInsights.scores.competitionScore, secondInsights.scores.competitionScore),
      freshnessScore: metric(firstInsights.scores.freshnessScore, secondInsights.scores.freshnessScore),
      completenessScore: metric(firstInsights.dataQuality.completenessScore, secondInsights.dataQuality.completenessScore)
    },
    assetOverlap: { shared: overlap, union, jaccardPct: union ? round((overlap / union) * 100) : 0 },
    keywordChanges: keywordChanges.slice(0, Math.min(Math.max(limit, 1), 500)),
    firstDataQuality: firstInsights.dataQuality,
    secondDataQuality: secondInsights.dataQuality
  };
}
