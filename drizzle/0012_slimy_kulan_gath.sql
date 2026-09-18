ALTER TABLE `asset_opportunity_snapshots` ADD `scoring_version` text DEFAULT 'mvp-1' NOT NULL;--> statement-breakpoint
ALTER TABLE `asset_opportunity_snapshots` ADD `score_status` text DEFAULT 'scored' NOT NULL;--> statement-breakpoint
ALTER TABLE `keyword_opportunity_snapshots` ADD `scoring_version` text DEFAULT 'mvp-1' NOT NULL;--> statement-breakpoint
ALTER TABLE `keyword_opportunity_snapshots` ADD `score_status` text DEFAULT 'scored' NOT NULL;--> statement-breakpoint
ALTER TABLE `keyword_opportunity_snapshots` ADD `rank_level` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `search_queries` ADD `result_count_raw` text;--> statement-breakpoint
ALTER TABLE `search_queries` ADD `result_count_qualifier` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `search_queries` ADD `requested_limit` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `search_queries` ADD `collected_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `search_queries` ADD `collection_status` text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE `suggestions` ADD `is_seed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `suggestions` ADD `autocomplete_prefix` text;