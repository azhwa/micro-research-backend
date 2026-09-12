CREATE TABLE `ai_recommendations` (
	`id` text PRIMARY KEY NOT NULL,
	`research_run_id` text,
	`scope` text DEFAULT 'run' NOT NULL,
	`prompt_version` text NOT NULL,
	`model` text,
	`input_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`request_json` text,
	`response_json` text,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`research_run_id`) REFERENCES `research_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_recommendations_run_idx` ON `ai_recommendations` (`research_run_id`);--> statement-breakpoint
CREATE INDEX `ai_recommendations_status_idx` ON `ai_recommendations` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_recommendations_input_idx` ON `ai_recommendations` (`input_hash`);--> statement-breakpoint
ALTER TABLE `keyword_opportunity_snapshots` ADD `category` text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE `research_jobs` ADD `heartbeat_at` integer;--> statement-breakpoint
ALTER TABLE `research_runs` ADD `category` text DEFAULT 'general' NOT NULL;