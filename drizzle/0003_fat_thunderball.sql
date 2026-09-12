CREATE TABLE `research_events` (
	`id` text PRIMARY KEY NOT NULL,
	`research_run_id` text NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`event_type` text NOT NULL,
	`message` text NOT NULL,
	`metadata_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`research_run_id`) REFERENCES `research_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `research_events_run_idx` ON `research_events` (`research_run_id`);--> statement-breakpoint
CREATE INDEX `research_events_created_idx` ON `research_events` (`created_at`);