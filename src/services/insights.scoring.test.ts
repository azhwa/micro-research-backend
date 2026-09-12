import assert from "node:assert/strict";
import { calculateOpportunityScore } from "./insights.service";

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
console.log("Scoring fixtures passed");
