import { desc, eq } from "drizzle-orm";
import { researchRuns } from "../db/schema";
import { getDatabase } from "../db/client";
import { getResearchInsights, SCORING_VERSION } from "../services/insights.service";

async function main() {
  const database = getDatabase();
  const runs = await database.select({ id: researchRuns.id, seedKeyword: researchRuns.seedKeyword })
    .from(researchRuns)
    .where(eq(researchRuns.status, "completed"))
    .orderBy(desc(researchRuns.completedAt))
    .limit(20);

  const summaries = (await Promise.all(runs.map(async (run) => ({
    run,
    insights: await getResearchInsights(run.id, 500)
  })))).filter((item) => item.insights !== null);

  const keywords = summaries.flatMap((item) => item.insights?.topKeywords ?? []);
  const scored = keywords.filter((item) => item.score !== null && !item.isSeed);
  const invalidInheritedScores = keywords.filter((item) => item.researchStatus === "discovered" && item.score !== null);
  const invalidSeedRanks = keywords.filter((item) => item.isSeed && item.rank !== null);
  const levels = Object.fromEntries([0, 1, 2, 3, 4, 5].map((level) => [level, keywords.filter((item) => item.level === level).length]));
  const scores = scored.map((item) => item.score as number).sort((a, b) => a - b);
  const percentile = (value: number) => scores.length ? scores[Math.min(scores.length - 1, Math.floor((scores.length - 1) * value))] : null;

  const report = {
    scoringVersion: SCORING_VERSION,
    generatedAt: new Date().toISOString(),
    dataset: { requestedRuns: 20, evaluatedRuns: summaries.length, keywords: keywords.length, scoredRelatedKeywords: scored.length },
    distribution: { min: scores[0] ?? null, p25: percentile(0.25), median: percentile(0.5), p75: percentile(0.75), max: scores.at(-1) ?? null, levels },
    invariants: {
      discoveredKeywordInheritedScore: invalidInheritedScores.length,
      seedIncludedInOrdinalRank: invalidSeedRanks.length,
      passed: invalidInheritedScores.length === 0 && invalidSeedRanks.length === 0
    },
    perRun: summaries.map(({ run, insights }) => ({
      runId: run.id,
      seedKeyword: run.seedKeyword,
      confidence: insights?.dataQuality.confidence,
      completenessScore: insights?.dataQuality.completenessScore,
      scoredKeywords: insights?.totals.scoredKeywords,
      opportunityScore: insights?.scores.opportunityScore,
      warnings: insights?.dataQuality.warnings
    }))
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.invariants.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
