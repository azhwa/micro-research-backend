ALTER TABLE `asset_observations` RENAME COLUMN "created_at" TO "observed_at";--> statement-breakpoint
ALTER TABLE `search_queries` RENAME COLUMN "created_at" TO "observed_at";--> statement-breakpoint
ALTER TABLE `suggestions` RENAME COLUMN "created_at" TO "observed_at";