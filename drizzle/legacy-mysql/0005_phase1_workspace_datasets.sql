ALTER TABLE `datasets` MODIFY COLUMN `projectId` int;--> statement-breakpoint
ALTER TABLE `datasets` ADD `workspaceId` int;--> statement-breakpoint
ALTER TABLE `datasets` ADD `rowCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `datasets` ADD CONSTRAINT `datasets_workspace_name_unq` UNIQUE(`workspaceId`,`name`);--> statement-breakpoint
CREATE INDEX `datasets_workspace_idx` ON `datasets` (`workspaceId`);