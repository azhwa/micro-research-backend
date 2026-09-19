ALTER TABLE `seed_discovery_jobs` ADD `summary` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `seed_discovery_jobs` ADD `cautions_json` text DEFAULT '[]' NOT NULL;