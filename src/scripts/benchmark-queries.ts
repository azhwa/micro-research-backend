import { primaryClient, isDatabaseConfigured } from "../db/client";
import { env } from "../config/env";
import { SCORING_VERSION } from "../services/insights.service";

type QueryCase = { name: string; sql: string; args: Array<string | number> };

const queries: QueryCase[] = [
  {
    name: "keyword snapshot latest page",
    sql: `EXPLAIN QUERY PLAN
      SELECT k.id
      FROM keyword_opportunity_snapshots k
      INNER JOIN research_runs r ON k.research_run_id = r.id
      WHERE k.scoring_version = ?
        AND k.score_status IN ('provisional', 'scored', 'discovery')
        AND r.status = 'completed'
      ORDER BY k.observed_at DESC, k.id ASC
      LIMIT 500`,
    args: [SCORING_VERSION]
  },
  {
    name: "asset snapshot latest page",
    sql: `EXPLAIN QUERY PLAN
      SELECT s.id
      FROM asset_opportunity_snapshots s
      INNER JOIN research_runs r ON s.research_run_id = r.id
      WHERE s.scoring_version = ?
        AND s.score_status = 'scored'
        AND s.asset_score > 0
        AND r.status = 'completed'
      ORDER BY s.observed_at DESC, s.id ASC
      LIMIT 500`,
    args: [SCORING_VERSION]
  },
  {
    name: "completed runs by owner",
    sql: `EXPLAIN QUERY PLAN
      SELECT id
      FROM research_runs
      WHERE owner_clerk_user_id = ?
        AND status = 'completed'
      ORDER BY completed_at DESC
      LIMIT 50`,
    args: ["benchmark-user"]
  }
];

async function main() {
  if (!isDatabaseConfigured || !primaryClient) throw new Error("Database utama belum dikonfigurasi");
  console.log(JSON.stringify({ databaseDriver: env.databaseDriver, database: "primary" }));
  for (const query of queries) {
    const startedAt = performance.now();
    const plan = await primaryClient.execute({ sql: query.sql, args: query.args });
    const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
    console.log(JSON.stringify({ name: query.name, elapsedMs, plan: plan.rows }));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
