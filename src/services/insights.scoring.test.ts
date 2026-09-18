import assert from "node:assert/strict";
import { calculateKeywordSignalScore, calculateOpportunityScore } from "./insights.service";
import { lowCompetitionScore, normalizeKeyword, parseAdobeResultCount, rankSignal } from "./research-metrics";

const strong = calculateOpportunityScore({
  demandScore: 100,
  freshnessScore: 100,
  consistencyScore: 100,
  competitionScore: 100
});
const weak = calculateOpportunityScore({
  demandScore: 25,
  freshnessScore: 25,
  consistencyScore: 25,
  competitionScore: 25
});
const demandHeavy = calculateOpportunityScore({
  demandScore: 100,
  freshnessScore: 0,
  consistencyScore: 0,
  competitionScore: 0
});

assert.equal(strong, 100);
assert.equal(weak, 25);
assert.equal(demandHeavy, 40);
assert.ok(strong > weak);

const candidate = calculateKeywordSignalScore({
  downloadSignalScore: 80,
  lowCompetitionScore: 70,
  relevanceSignalScore: 60,
  freshnessSignalScore: 50,
  crossSortScore: 100,
  autocompleteScore: 90
});
assert.equal(candidate, 75.5);

assert.deepEqual(parseAdobeResultCount("1,000,000+ results"), {
  value: 1_000_000,
  raw: "1,000,000+ results",
  qualifier: "at_least"
});
assert.equal(parseAdobeResultCount("About 250,000 results").qualifier, "approximate");
assert.equal(parseAdobeResultCount("No numeric total").qualifier, "unknown");
assert.ok((lowCompetitionScore(5_000, "displayed") ?? 0) > (lowCompetitionScore(5_000_000, "displayed") ?? 100));
assert.ok((lowCompetitionScore(100_000, "at_least") ?? 100) < (lowCompetitionScore(100_000, "displayed") ?? 0));
assert.equal(rankSignal(1, 100), 100);
assert.equal(rankSignal(null, 100), null);
assert.equal(normalizeKeyword("  Cat's—Portrait!  "), "cat s portrait");
console.log("Scoring fixtures passed");
