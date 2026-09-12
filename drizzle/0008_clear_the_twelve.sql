CREATE TABLE `gemini_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_clerk_user_id` text NOT NULL,
	`label` text NOT NULL,
	`encrypted_key` text NOT NULL,
	`key_hint` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`cooldown_until` integer,
	`last_used_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `gemini_keys_owner_idx` ON `gemini_api_keys` (`owner_clerk_user_id`);--> statement-breakpoint
CREATE INDEX `gemini_keys_status_idx` ON `gemini_api_keys` (`status`);