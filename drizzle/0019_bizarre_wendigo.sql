CREATE TABLE `prompt_queue_items` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`organization_id` text,
	`source_readout_id` text,
	`keyword` text NOT NULL,
	`normalized_keyword` text NOT NULL,
	`category` text DEFAULT 'general' NOT NULL,
	`research_asset_type` text DEFAULT 'images' NOT NULL,
	`prompt_output_type` text DEFAULT 'image' NOT NULL,
	`locale` text DEFAULT 'en-GB' NOT NULL,
	`prompt_count` integer DEFAULT 5 NOT NULL,
	`recommended_style` text DEFAULT 'commercial stock photography' NOT NULL,
	`style_rationale` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`generation_id` text,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`source_readout_id`) REFERENCES `ai_recommendations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`generation_id`) REFERENCES `ai_recommendations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `prompt_queue_owner_created_idx` ON `prompt_queue_items` (`owner_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `prompt_queue_org_created_idx` ON `prompt_queue_items` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `prompt_queue_status_idx` ON `prompt_queue_items` (`status`);--> statement-breakpoint
CREATE INDEX `prompt_queue_keyword_idx` ON `prompt_queue_items` (`normalized_keyword`);--> statement-breakpoint
ALTER TABLE `ai_recommendations` ADD `readout_type` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
CREATE INDEX `ai_recommendations_scope_type_idx` ON `ai_recommendations` (`scope`,`readout_type`);