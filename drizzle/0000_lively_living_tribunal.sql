CREATE TABLE `asset_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`research_run_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`search_query_id` text NOT NULL,
	`sort_mode` text NOT NULL,
	`rank` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`research_run_id`) REFERENCES `research_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`search_query_id`) REFERENCES `search_queries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `asset_observations_run_idx` ON `asset_observations` (`research_run_id`);--> statement-breakpoint
CREATE INDEX `asset_observations_asset_idx` ON `asset_observations` (`asset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `asset_observations_unique_idx` ON `asset_observations` (`research_run_id`,`asset_id`,`search_query_id`,`sort_mode`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text DEFAULT 'adobe_stock' NOT NULL,
	`external_id` text NOT NULL,
	`asset_type` text NOT NULL,
	`title` text NOT NULL,
	`asset_url` text NOT NULL,
	`thumbnail_url` text,
	`width` integer,
	`height` integer,
	`file_extension` text,
	`is_premium` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_platform_external_idx` ON `assets` (`platform`,`external_id`);--> statement-breakpoint
CREATE TABLE `research_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`research_run_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`locked_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`research_run_id`) REFERENCES `research_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `research_jobs_status_idx` ON `research_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `research_jobs_run_idx` ON `research_jobs` (`research_run_id`);--> statement-breakpoint
CREATE TABLE `research_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`seed_keyword` text NOT NULL,
	`asset_type` text DEFAULT 'images' NOT NULL,
	`locale` text DEFAULT 'en-US' NOT NULL,
	`max_suggestions` integer DEFAULT 30 NOT NULL,
	`assets_per_query` integer DEFAULT 30 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`progress_total` integer DEFAULT 0 NOT NULL,
	`progress_completed` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `research_runs_status_idx` ON `research_runs` (`status`);--> statement-breakpoint
CREATE TABLE `search_queries` (
	`id` text PRIMARY KEY NOT NULL,
	`research_run_id` text NOT NULL,
	`query` text NOT NULL,
	`asset_type` text DEFAULT 'images' NOT NULL,
	`sort_mode` text NOT NULL,
	`page` integer DEFAULT 1 NOT NULL,
	`result_count` integer,
	`locale` text DEFAULT 'en-US' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`research_run_id`) REFERENCES `research_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `search_queries_run_idx` ON `search_queries` (`research_run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `search_queries_unique_idx` ON `search_queries` (`research_run_id`,`query`,`sort_mode`,`page`);--> statement-breakpoint
CREATE TABLE `suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`research_run_id` text NOT NULL,
	`base_keyword` text NOT NULL,
	`suggestion` text NOT NULL,
	`position` integer NOT NULL,
	`source` text DEFAULT 'autocomplete' NOT NULL,
	`locale` text DEFAULT 'en-US' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`research_run_id`) REFERENCES `research_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `suggestions_run_idx` ON `suggestions` (`research_run_id`);--> statement-breakpoint
CREATE INDEX `suggestions_text_idx` ON `suggestions` (`suggestion`);