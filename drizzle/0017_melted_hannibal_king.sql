CREATE TABLE `research_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`seed_keyword` text NOT NULL,
	`category` text DEFAULT 'general' NOT NULL,
	`owner_clerk_user_id` text,
	`organization_id` text,
	`asset_type` text DEFAULT 'images' NOT NULL,
	`locale` text DEFAULT 'en-GB' NOT NULL,
	`mode` text DEFAULT 'full' NOT NULL,
	`max_suggestions` integer DEFAULT 1 NOT NULL,
	`assets_per_query` integer DEFAULT 100 NOT NULL,
	`autocomplete_enabled` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`research_run_id` text,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `research_queue_status_idx` ON `research_queue` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `research_queue_owner_idx` ON `research_queue` (`owner_clerk_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `research_queue_org_idx` ON `research_queue` (`organization_id`,`status`);