CREATE TABLE `seed_discovery_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`keyword` text NOT NULL,
	`normalized_keyword` text NOT NULL,
	`source` text NOT NULL,
	`opportunity_score` real,
	`confidence` text DEFAULT 'low' NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`rationale` text DEFAULT '' NOT NULL,
	`prompt_angles_json` text DEFAULT '[]' NOT NULL,
	`rank` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `seed_discovery_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `seed_discovery_candidates_job_idx` ON `seed_discovery_candidates` (`job_id`);--> statement-breakpoint
CREATE INDEX `seed_discovery_candidates_keyword_idx` ON `seed_discovery_candidates` (`normalized_keyword`);--> statement-breakpoint
CREATE UNIQUE INDEX `seed_discovery_candidates_unique_idx` ON `seed_discovery_candidates` (`job_id`,`normalized_keyword`);--> statement-breakpoint
CREATE TABLE `seed_discovery_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`organization_id` text,
	`topic` text DEFAULT '' NOT NULL,
	`category` text DEFAULT 'general' NOT NULL,
	`asset_type` text DEFAULT 'images' NOT NULL,
	`locale` text DEFAULT 'en-GB' NOT NULL,
	`requested_count` integer DEFAULT 10 NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`input_hash` text NOT NULL,
	`context_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`progress_total` integer DEFAULT 1 NOT NULL,
	`progress_completed` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `seed_discovery_jobs_owner_idx` ON `seed_discovery_jobs` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `seed_discovery_jobs_status_idx` ON `seed_discovery_jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `seed_discovery_jobs_input_idx` ON `seed_discovery_jobs` (`input_hash`);