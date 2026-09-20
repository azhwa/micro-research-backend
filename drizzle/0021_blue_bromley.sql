ALTER TABLE `ai_recommendations` ADD `context_hash` text;--> statement-breakpoint
ALTER TABLE `ai_recommendations` ADD `generation_group_id` text;--> statement-breakpoint
ALTER TABLE `ai_recommendations` ADD `generation_index` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_recommendations` ADD `generation_seed` text;--> statement-breakpoint
ALTER TABLE `ai_recommendations` ADD `generation_title` text;--> statement-breakpoint
ALTER TABLE `ai_recommendations` ADD `novelty_context_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_recommendations` ADD `output_type` text;--> statement-breakpoint
ALTER TABLE `ai_recommendations` ADD `recommended_style` text;--> statement-breakpoint
CREATE INDEX `ai_recommendations_generation_group_idx` ON `ai_recommendations` (`generation_group_id`,`generation_index`);