CREATE INDEX `asset_snapshots_version_status_idx` ON `asset_opportunity_snapshots` (`scoring_version`,`score_status`);--> statement-breakpoint
CREATE INDEX `keyword_snapshots_version_status_idx` ON `keyword_opportunity_snapshots` (`scoring_version`,`score_status`);--> statement-breakpoint
CREATE INDEX `research_runs_owner_idx` ON `research_runs` (`owner_clerk_user_id`);--> statement-breakpoint
CREATE INDEX `research_runs_org_idx` ON `research_runs` (`organization_id`);