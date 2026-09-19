CREATE TABLE `global_insights_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`organization_id` text,
	`scoring_version` text NOT NULL,
	`payload_json` text NOT NULL,
	`generated_at` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `global_insights_cache_owner_idx` ON `global_insights_cache` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `global_insights_cache_org_idx` ON `global_insights_cache` (`organization_id`);--> statement-breakpoint
CREATE INDEX `global_insights_cache_version_idx` ON `global_insights_cache` (`scoring_version`);--> statement-breakpoint
CREATE INDEX `asset_keywords_run_asset_position_idx` ON `asset_keywords` (`research_run_id`,`asset_id`,`position`);--> statement-breakpoint
CREATE INDEX `asset_observations_run_sort_rank_idx` ON `asset_observations` (`research_run_id`,`sort_mode`,`rank`);--> statement-breakpoint
CREATE INDEX `asset_snapshots_version_status_observed_idx` ON `asset_opportunity_snapshots` (`scoring_version`,`score_status`,`observed_at`);--> statement-breakpoint
CREATE INDEX `asset_snapshots_run_observed_idx` ON `asset_opportunity_snapshots` (`research_run_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `keyword_snapshots_version_status_observed_idx` ON `keyword_opportunity_snapshots` (`scoring_version`,`score_status`,`observed_at`);--> statement-breakpoint
CREATE INDEX `keyword_snapshots_run_observed_idx` ON `keyword_opportunity_snapshots` (`research_run_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `research_runs_owner_status_idx` ON `research_runs` (`owner_clerk_user_id`,`status`,`completed_at`);--> statement-breakpoint
CREATE INDEX `research_runs_org_status_idx` ON `research_runs` (`organization_id`,`status`,`completed_at`);