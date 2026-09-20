import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex
} from "drizzle-orm/sqlite-core";

const timestampColumn = (name: string) =>
  integer(name, { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

const createdAt = () => timestampColumn("created_at");

const observedAt = () => timestampColumn("observed_at");

const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

export const researchRuns = sqliteTable(
  "research_runs",
  {
    id: text("id").primaryKey(),
    seedKeyword: text("seed_keyword").notNull(),
    category: text("category").notNull().default("general"),
    ownerUserId: text("owner_clerk_user_id"),
    organizationId: text("organization_id"),
    assetType: text("asset_type").notNull().default("images"),
    locale: text("locale").notNull().default("en-US"),
    maxSuggestions: integer("max_suggestions").notNull().default(30),
    assetsPerQuery: integer("assets_per_query").notNull().default(30),
    autocompleteEnabled: integer("autocomplete_enabled", { mode: "boolean" }).notNull().default(true),
    mode: text("mode").notNull().default("full"),
    status: text("status").notNull().default("pending"),
    progressTotal: integer("progress_total").notNull().default(0),
    progressCompleted: integer("progress_completed").notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" })
  },
  (table) => [
    index("research_runs_status_idx").on(table.status),
    index("research_runs_owner_idx").on(table.ownerUserId),
    index("research_runs_org_idx").on(table.organizationId),
    index("research_runs_owner_status_idx").on(table.ownerUserId, table.status, table.completedAt),
    index("research_runs_org_status_idx").on(table.organizationId, table.status, table.completedAt)
  ]
);

export const researchJobs = sqliteTable(
  "research_jobs",
  {
    id: text("id").primaryKey(),
    researchRunId: text("research_run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lockedAt: integer("locked_at", { mode: "timestamp_ms" }),
    heartbeatAt: integer("heartbeat_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index("research_jobs_status_idx").on(table.status),
    index("research_jobs_run_idx").on(table.researchRunId)
  ]
);

export const researchQueue = sqliteTable(
  "research_queue",
  {
    id: text("id").primaryKey(),
    seedKeyword: text("seed_keyword").notNull(),
    category: text("category").notNull().default("general"),
    ownerUserId: text("owner_clerk_user_id"),
    organizationId: text("organization_id"),
    assetType: text("asset_type").notNull().default("images"),
    locale: text("locale").notNull().default("en-GB"),
    mode: text("mode").notNull().default("full"),
    maxSuggestions: integer("max_suggestions").notNull().default(1),
    assetsPerQuery: integer("assets_per_query").notNull().default(100),
    autocompleteEnabled: integer("autocomplete_enabled", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull().default("queued"),
    researchRunId: text("research_run_id"),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    updatedAt: updatedAt()
  },
  (table) => [
    index("research_queue_status_idx").on(table.status, table.createdAt),
    index("research_queue_owner_idx").on(table.ownerUserId, table.status),
    index("research_queue_org_idx").on(table.organizationId, table.status)
  ]
);

export const researchEvents = sqliteTable(
  "research_events",
  {
    id: text("id").primaryKey(),
    researchRunId: text("research_run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    level: text("level").notNull().default("info"),
    eventType: text("event_type").notNull(),
    message: text("message").notNull(),
    metadataJson: text("metadata_json"),
    createdAt: createdAt()
  },
  (table) => [
    index("research_events_run_idx").on(table.researchRunId),
    index("research_events_created_idx").on(table.createdAt)
  ]
);

export const suggestions = sqliteTable(
  "suggestions",
  {
    id: text("id").primaryKey(),
    researchRunId: text("research_run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    baseKeyword: text("base_keyword").notNull(),
    suggestion: text("suggestion").notNull(),
    position: integer("position").notNull(),
    source: text("source").notNull().default("autocomplete"),
    isSeed: integer("is_seed", { mode: "boolean" }).notNull().default(false),
    autocompletePrefix: text("autocomplete_prefix"),
    locale: text("locale").notNull().default("en-US"),
    observedAt: observedAt()
  },
  (table) => [
    index("suggestions_run_idx").on(table.researchRunId),
    index("suggestions_text_idx").on(table.suggestion)
  ]
);

export const searchQueries = sqliteTable(
  "search_queries",
  {
    id: text("id").primaryKey(),
    researchRunId: text("research_run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    assetType: text("asset_type").notNull().default("images"),
    sortMode: text("sort_mode").notNull(),
    page: integer("page").notNull().default(1),
    resultCount: integer("result_count"),
    resultCountRaw: text("result_count_raw"),
    resultCountQualifier: text("result_count_qualifier").notNull().default("unknown"),
    requestedLimit: integer("requested_limit").notNull().default(0),
    collectedCount: integer("collected_count").notNull().default(0),
    collectionStatus: text("collection_status").notNull().default("completed"),
    isComplete: integer("is_complete", { mode: "boolean" }).notNull().default(false),
    locale: text("locale").notNull().default("en-US"),
    observedAt: observedAt()
  },
  (table) => [
    index("search_queries_run_idx").on(table.researchRunId),
    uniqueIndex("search_queries_unique_idx").on(
      table.researchRunId,
      table.query,
      table.sortMode,
      table.page
    )
  ]
);

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    platform: text("platform").notNull().default("adobe_stock"),
    externalId: text("external_id").notNull(),
    assetType: text("asset_type").notNull(),
    title: text("title").notNull(),
    assetUrl: text("asset_url").notNull(),
    thumbnailUrl: text("thumbnail_url"),
    width: integer("width"),
    height: integer("height"),
    fileExtension: text("file_extension"),
    isPremium: integer("is_premium", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("assets_platform_external_idx").on(
      table.platform,
      table.externalId
    )
  ]
);

export const assetObservations = sqliteTable(
  "asset_observations",
  {
    id: text("id").primaryKey(),
    researchRunId: text("research_run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    searchQueryId: text("search_query_id")
      .notNull()
      .references(() => searchQueries.id, { onDelete: "cascade" }),
    sortMode: text("sort_mode").notNull(),
    rank: integer("rank").notNull(),
    observedAt: observedAt()
  },
  (table) => [
    index("asset_observations_run_idx").on(table.researchRunId),
    index("asset_observations_asset_idx").on(table.assetId),
    index("asset_observations_run_sort_rank_idx").on(table.researchRunId, table.sortMode, table.rank),
    uniqueIndex("asset_observations_unique_idx").on(
      table.researchRunId,
      table.assetId,
      table.searchQueryId,
      table.sortMode
    )
  ]
);

export const assetKeywords = sqliteTable(
  "asset_keywords",
  {
    id: text("id").primaryKey(),
    researchRunId: text("research_run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    normalizedKeyword: text("normalized_keyword").notNull(),
    source: text("source").notNull().default("adobe_similar_keywords"),
    position: integer("position").notNull(),
    observedAt: observedAt()
  },
  (table) => [
    index("asset_keywords_run_idx").on(table.researchRunId),
    index("asset_keywords_keyword_idx").on(table.normalizedKeyword),
    index("asset_keywords_run_asset_position_idx").on(table.researchRunId, table.assetId, table.position),
    uniqueIndex("asset_keywords_unique_idx").on(
      table.researchRunId,
      table.assetId,
      table.normalizedKeyword,
      table.source
    )
  ]
);

export const keywordOpportunitySnapshots = sqliteTable(
  "keyword_opportunity_snapshots",
  {
    id: text("id").primaryKey(),
    researchRunId: text("research_run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    category: text("category").notNull().default("general"),
    normalizedKeyword: text("normalized_keyword").notNull(),
    displayKeyword: text("display_keyword").notNull(),
    assetType: text("asset_type").notNull(),
    locale: text("locale").notNull(),
    source: text("source").notNull(),
    autocompletePosition: integer("autocomplete_position"),
    suggestionFrequency: integer("suggestion_frequency").notNull().default(0),
    queryCount: integer("query_count").notNull().default(0),
    assetCount: integer("asset_count").notNull().default(0),
    bestDownloadRank: integer("best_download_rank"),
    averageDownloadRank: real("average_download_rank"),
    bestRecentRank: integer("best_recent_rank"),
    resultCount: integer("result_count"),
    demandScore: real("demand_score").notNull().default(0),
    competitionScore: real("competition_score").notNull().default(0),
    freshnessScore: real("freshness_score").notNull().default(0),
    consistencyScore: real("consistency_score").notNull().default(0),
    opportunityScore: real("opportunity_score").notNull().default(0),
    scoringVersion: text("scoring_version").notNull().default("mvp-1"),
    scoreStatus: text("score_status").notNull().default("scored"),
    rankLevel: integer("rank_level").notNull().default(0),
    observedAt: observedAt()
  },
  (table) => [
    index("keyword_snapshots_keyword_idx").on(table.normalizedKeyword),
    index("keyword_snapshots_run_idx").on(table.researchRunId),
    index("keyword_snapshots_score_idx").on(table.opportunityScore),
    index("keyword_snapshots_version_status_idx").on(table.scoringVersion, table.scoreStatus),
    index("keyword_snapshots_version_status_observed_idx").on(table.scoringVersion, table.scoreStatus, table.observedAt),
    index("keyword_snapshots_run_observed_idx").on(table.researchRunId, table.observedAt),
    uniqueIndex("keyword_snapshots_unique_idx").on(
      table.researchRunId,
      table.normalizedKeyword,
      table.assetType,
      table.locale
    )
  ]
);

export const assetOpportunitySnapshots = sqliteTable(
  "asset_opportunity_snapshots",
  {
    id: text("id").primaryKey(),
    researchRunId: text("research_run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    appearances: integer("appearances").notNull().default(0),
    bestDownloadRank: integer("best_download_rank"),
    bestRecentRank: integer("best_recent_rank"),
    bestRelevanceRank: integer("best_relevance_rank"),
    keywordCount: integer("keyword_count").notNull().default(0),
    assetScore: real("asset_score").notNull().default(0),
    scoringVersion: text("scoring_version").notNull().default("mvp-1"),
    scoreStatus: text("score_status").notNull().default("scored"),
    observedAt: observedAt()
  },
  (table) => [
    index("asset_snapshots_run_idx").on(table.researchRunId),
    index("asset_snapshots_asset_idx").on(table.assetId),
    index("asset_snapshots_version_status_idx").on(table.scoringVersion, table.scoreStatus),
    index("asset_snapshots_version_status_observed_idx").on(table.scoringVersion, table.scoreStatus, table.observedAt),
    index("asset_snapshots_run_observed_idx").on(table.researchRunId, table.observedAt),
    uniqueIndex("asset_snapshots_unique_idx").on(table.researchRunId, table.assetId)
  ]
);

export const globalInsightsCache = sqliteTable(
  "global_insights_cache",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id"),
    organizationId: text("organization_id"),
    scoringVersion: text("scoring_version").notNull(),
    payloadJson: text("payload_json").notNull(),
    generatedAt: integer("generated_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: updatedAt()
  },
  (table) => [
    index("global_insights_cache_owner_idx").on(table.ownerUserId),
    index("global_insights_cache_org_idx").on(table.organizationId),
    index("global_insights_cache_version_idx").on(table.scoringVersion)
  ]
);

export const aiRecommendations = sqliteTable(
  "ai_recommendations",
  {
    id: text("id").primaryKey(),
    researchRunId: text("research_run_id").references(() => researchRuns.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("run"),
    readoutType: text("readout_type").notNull().default("legacy"),
    promptVersion: text("prompt_version").notNull(),
    model: text("model"),
    inputHash: text("input_hash").notNull(),
    contextHash: text("context_hash"),
    generationGroupId: text("generation_group_id"),
    generationIndex: integer("generation_index").notNull().default(1),
    generationSeed: text("generation_seed"),
    generationTitle: text("generation_title"),
    noveltyContextJson: text("novelty_context_json").notNull().default("{}"),
    outputType: text("output_type"),
    recommendedStyle: text("recommended_style"),
    readoutFiltersJson: text("readout_filters_json").notNull().default("{}"),
    status: text("status").notNull().default("pending"),
    requestJson: text("request_json"),
    responseJson: text("response_json"),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" })
  },
  (table) => [
    index("ai_recommendations_run_idx").on(table.researchRunId),
    index("ai_recommendations_scope_type_idx").on(table.scope, table.readoutType),
    index("ai_recommendations_generation_group_idx").on(table.generationGroupId, table.generationIndex),
    index("ai_recommendations_status_idx").on(table.status),
    uniqueIndex("ai_recommendations_input_idx").on(table.inputHash)
  ]
);

export const savedPrompts = sqliteTable(
  "saved_prompts",
  {
    id: text("id").primaryKey(),
    generationId: text("generation_id").references(() => aiRecommendations.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id"),
    organizationId: text("organization_id"),
    seed: text("seed").notNull(),
    category: text("category").notNull().default("general"),
    assetType: text("asset_type").notNull().default("images"),
    locale: text("locale").notNull().default("en-GB"),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    negativePrompt: text("negative_prompt").notNull().default(""),
    keywordFocusJson: text("keyword_focus_json").notNull().default("[]"),
    commercialRationale: text("commercial_rationale").notNull().default(""),
    confidence: text("confidence").notNull().default("medium"),
    status: text("status").notNull().default("saved"),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index("saved_prompts_owner_created_idx").on(table.ownerUserId, table.createdAt),
    index("saved_prompts_org_created_idx").on(table.organizationId, table.createdAt),
    index("saved_prompts_generation_idx").on(table.generationId),
    index("saved_prompts_status_idx").on(table.status)
  ]
);

export const promptQueueItems = sqliteTable(
  "prompt_queue_items",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id"),
    organizationId: text("organization_id"),
    sourceReadoutId: text("source_readout_id").references(() => aiRecommendations.id, { onDelete: "set null" }),
    sourceScore: real("source_score"),
    sourceLevel: integer("source_level"),
    sourceConfidence: text("source_confidence"),
    sourceEvidenceJson: text("source_evidence_json").notNull().default("[]"),
    sourceObservedAt: integer("source_observed_at", { mode: "timestamp_ms" }),
    keyword: text("keyword").notNull(),
    normalizedKeyword: text("normalized_keyword").notNull(),
    category: text("category").notNull().default("general"),
    researchAssetType: text("research_asset_type").notNull().default("images"),
    promptOutputType: text("prompt_output_type").notNull().default("image"),
    locale: text("locale").notNull().default("en-GB"),
    promptCount: integer("prompt_count").notNull().default(5),
    recommendedStyle: text("recommended_style").notNull().default("commercial stock photography"),
    styleRationale: text("style_rationale").notNull().default(""),
    status: text("status").notNull().default("queued"),
    generationId: text("generation_id").references(() => aiRecommendations.id, { onDelete: "set null" }),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    updatedAt: updatedAt()
  },
  (table) => [
    index("prompt_queue_owner_created_idx").on(table.ownerUserId, table.createdAt),
    index("prompt_queue_org_created_idx").on(table.organizationId, table.createdAt),
    index("prompt_queue_status_idx").on(table.status),
    index("prompt_queue_keyword_idx").on(table.normalizedKeyword)
  ]
);

export const seedDiscoveryJobs = sqliteTable(
  "seed_discovery_jobs",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    organizationId: text("organization_id"),
    topic: text("topic").notNull().default(""),
    category: text("category").notNull().default("general"),
    assetType: text("asset_type").notNull().default("images"),
    locale: text("locale").notNull().default("en-GB"),
    requestedCount: integer("requested_count").notNull().default(10),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputHash: text("input_hash").notNull(),
    contextJson: text("context_json").notNull(),
    status: text("status").notNull().default("pending"),
    progressTotal: integer("progress_total").notNull().default(1),
    progressCompleted: integer("progress_completed").notNull().default(0),
    summary: text("summary").notNull().default(""),
    cautionsJson: text("cautions_json").notNull().default("[]"),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    updatedAt: updatedAt()
  },
  (table) => [
    index("seed_discovery_jobs_owner_idx").on(table.ownerUserId),
    index("seed_discovery_jobs_status_idx").on(table.status, table.createdAt),
    uniqueIndex("seed_discovery_jobs_input_idx").on(table.inputHash)
  ]
);

export const seedDiscoveryCandidates = sqliteTable(
  "seed_discovery_candidates",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => seedDiscoveryJobs.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    normalizedKeyword: text("normalized_keyword").notNull(),
    source: text("source").notNull(),
    opportunityScore: real("opportunity_score"),
    confidence: text("confidence").notNull().default("low"),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    rationale: text("rationale").notNull().default(""),
    promptAnglesJson: text("prompt_angles_json").notNull().default("[]"),
    rank: integer("rank").notNull().default(0),
    createdAt: createdAt()
  },
  (table) => [
    index("seed_discovery_candidates_job_idx").on(table.jobId),
    index("seed_discovery_candidates_keyword_idx").on(table.normalizedKeyword),
    uniqueIndex("seed_discovery_candidates_unique_idx").on(table.jobId, table.normalizedKeyword)
  ]
);

export const geminiApiKeys = sqliteTable(
  "gemini_api_keys",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_clerk_user_id").notNull(),
    label: text("label").notNull(),
    encryptedKey: text("encrypted_key").notNull(),
    keyHint: text("key_hint").notNull(),
    status: text("status").notNull().default("active"),
    failureCount: integer("failure_count").notNull().default(0),
    cooldownUntil: integer("cooldown_until", { mode: "timestamp_ms" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index("gemini_keys_owner_idx").on(table.ownerUserId),
    index("gemini_keys_status_idx").on(table.status)
  ]
);

export const proxyEndpoints = sqliteTable(
  "proxy_endpoints",
  {
    id: text("id").primaryKey(),
    createdByUserId: text("created_by_clerk_user_id").notNull(),
    label: text("label").notNull(),
    encryptedUrl: text("encrypted_url").notNull(),
    displayUrl: text("display_url").notNull(),
    status: text("status").notNull().default("active"),
    failureCount: integer("failure_count").notNull().default(0),
    lastTestAt: integer("last_test_at", { mode: "timestamp_ms" }),
    lastTestOk: integer("last_test_ok", { mode: "boolean" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index("proxy_endpoints_status_idx").on(table.status),
    index("proxy_endpoints_last_used_idx").on(table.lastUsedAt)
  ]
);
