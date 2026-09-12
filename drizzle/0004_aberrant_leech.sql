CREATE TABLE `asset_opportunity_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`research_run_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`appearances` integer DEFAULT 0 NOT NULL,
	`best_download_rank` integer,
	`best_recent_rank` integer,
	`best_relevance_rank` integer,
	`keyword_count` integer DEFAULT 0 NOT NULL,
	`asset_score` real DEFAULT 0 NOT NULL,
	`observed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`research_run_id`) REFERENCES `research_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `asset_snapshots_run_idx` ON `asset_opportunity_snapshots` (`research_run_id`);--> statement-breakpoint
CREATE INDEX `asset_snapshots_asset_idx` ON `asset_opportunity_snapshots` (`asset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `asset_snapshots_unique_idx` ON `asset_opportunity_snapshots` (`research_run_id`,`asset_id`);--> statement-breakpoint
CREATE TABLE `keyword_opportunity_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`research_run_id` text NOT NULL,
	`normalized_keyword` text NOT NULL,
	`display_keyword` text NOT NULL,
	`asset_type` text NOT NULL,
	`locale` text NOT NULL,
	`source` text NOT NULL,
	`autocomplete_position` integer,
	`suggestion_frequency` integer DEFAULT 0 NOT NULL,
	`query_count` integer DEFAULT 0 NOT NULL,
	`asset_count` integer DEFAULT 0 NOT NULL,
	`best_download_rank` integer,
	`average_download_rank` real,
	`best_recent_rank` integer,
	`result_count` integer,
	`demand_score` real DEFAULT 0 NOT NULL,
	`competition_score` real DEFAULT 0 NOT NULL,
	`freshness_score` real DEFAULT 0 NOT NULL,
	`consistency_score` real DEFAULT 0 NOT NULL,
	`opportunity_score` real DEFAULT 0 NOT NULL,
	`observed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`research_run_id`) REFERENCES `research_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `keyword_snapshots_keyword_idx` ON `keyword_opportunity_snapshots` (`normalized_keyword`);--> statement-breakpoint
CREATE INDEX `keyword_snapshots_run_idx` ON `keyword_opportunity_snapshots` (`research_run_id`);--> statement-breakpoint
CREATE INDEX `keyword_snapshots_score_idx` ON `keyword_opportunity_snapshots` (`opportunity_score`);--> statement-breakpoint
CREATE UNIQUE INDEX `keyword_snapshots_unique_idx` ON `keyword_opportunity_snapshots` (`research_run_id`,`normalized_keyword`,`asset_type`,`locale`);