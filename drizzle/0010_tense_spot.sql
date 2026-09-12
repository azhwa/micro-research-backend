CREATE TABLE `proxy_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`created_by_clerk_user_id` text NOT NULL,
	`label` text NOT NULL,
	`encrypted_url` text NOT NULL,
	`display_url` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_test_at` integer,
	`last_test_ok` integer,
	`last_used_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `proxy_endpoints_status_idx` ON `proxy_endpoints` (`status`);--> statement-breakpoint
CREATE INDEX `proxy_endpoints_last_used_idx` ON `proxy_endpoints` (`last_used_at`);