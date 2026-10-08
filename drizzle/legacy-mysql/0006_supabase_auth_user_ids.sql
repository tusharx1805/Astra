-- Supabase Auth is now the only identity source. User references become Supabase Auth UUIDs (varchar(36)).
-- Non-destructive: existing integer ids are kept as text. The legacy `users` table is intentionally NOT dropped
-- (drizzle-kit proposed DROP TABLE `users`; removed). Drop it manually once you no longer need its history.
ALTER TABLE `auditLogs` MODIFY COLUMN `actorId` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `changes` MODIFY COLUMN `authorId` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `dataset_connections` MODIFY COLUMN `createdBy` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `datasets` MODIFY COLUMN `ownerId` varchar(36);--> statement-breakpoint
ALTER TABLE `ingestion_attempts` MODIFY COLUMN `created_by` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `organizationMembers` MODIFY COLUMN `userId` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `pipelines` MODIFY COLUMN `ownerId` varchar(36);--> statement-breakpoint
ALTER TABLE `query_runs` MODIFY COLUMN `run_by` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `recently_viewed` MODIFY COLUMN `user_id` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `reviews` MODIFY COLUMN `reviewerId` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `saved_queries` MODIFY COLUMN `created_by` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaceInvitations` MODIFY COLUMN `invitedBy` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaceMembers` MODIFY COLUMN `userId` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` MODIFY COLUMN `createdBy` varchar(36) NOT NULL;