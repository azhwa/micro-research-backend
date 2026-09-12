CREATE TABLE `asset_keywords` (
	`id` text PRIMARY KEY NOT NULL,
	`research_run_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`keyword` text NOT NULL,
	`normalized_keyword` text NOT NULL,
	`source` text DEFAULT 'adobe_similar_keywords' NOT NULL,
	`position` integer NOT NULL,
	`observed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`research_run_id`) REFERENCES `research_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `asset_keywords_run_idx` ON `asset_keywords` (`research_run_id`);--> statement-breakpoint
CREATE INDEX `asset_keywords_keyword_idx` ON `asset_keywords` (`normalized_keyword`);--> statement-breakpoint
CREATE UNIQUE INDEX `asset_keywords_unique_idx` ON `asset_keywords` (`research_run_id`,`asset_id`,`normalized_keyword`,`source`);