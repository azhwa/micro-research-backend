CREATE TABLE `saved_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`generation_id` text,
	`owner_user_id` text,
	`organization_id` text,
	`seed` text NOT NULL,
	`category` text DEFAULT 'general' NOT NULL,
	`asset_type` text DEFAULT 'images' NOT NULL,
	`locale` text DEFAULT 'en-GB' NOT NULL,
	`title` text NOT NULL,
	`prompt` text NOT NULL,
	`negative_prompt` text DEFAULT '' NOT NULL,
	`keyword_focus_json` text DEFAULT '[]' NOT NULL,
	`commercial_rationale` text DEFAULT '' NOT NULL,
	`confidence` text DEFAULT 'medium' NOT NULL,
	`status` text DEFAULT 'saved' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`generation_id`) REFERENCES `ai_recommendations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `saved_prompts_owner_created_idx` ON `saved_prompts` (`owner_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `saved_prompts_org_created_idx` ON `saved_prompts` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `saved_prompts_generation_idx` ON `saved_prompts` (`generation_id`);--> statement-breakpoint
CREATE INDEX `saved_prompts_status_idx` ON `saved_prompts` (`status`);