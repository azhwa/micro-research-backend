ALTER TABLE `ai_recommendations` ADD `readout_filters_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `prompt_queue_items` ADD `source_score` real;--> statement-breakpoint
ALTER TABLE `prompt_queue_items` ADD `source_level` integer;--> statement-breakpoint
ALTER TABLE `prompt_queue_items` ADD `source_confidence` text;--> statement-breakpoint
ALTER TABLE `prompt_queue_items` ADD `source_evidence_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `prompt_queue_items` ADD `source_observed_at` integer;