CREATE TABLE `dataset_columns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`datasetId` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`dataType` varchar(32) NOT NULL,
	`nullable` int NOT NULL DEFAULT 1,
	`uniqueValues` int NOT NULL DEFAULT 0,
	`nullPercent` int NOT NULL DEFAULT 0,
	CONSTRAINT `dataset_columns_id` PRIMARY KEY(`id`),
	CONSTRAINT `dataset_column_name_unq` UNIQUE(`datasetId`,`name`)
);
--> statement-breakpoint
CREATE TABLE `dataset_connections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`type` varchar(32) NOT NULL,
	`host` varchar(255) NOT NULL,
	`port` int NOT NULL,
	`databaseName` varchar(160) NOT NULL,
	`username` varchar(160) NOT NULL,
	`encryptedPassword` text NOT NULL,
	`sslMode` varchar(32) NOT NULL,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `dataset_connections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `dataset_rows` (
	`id` int AUTO_INCREMENT NOT NULL,
	`datasetId` int NOT NULL,
	`rowIndex` int NOT NULL,
	`data` json NOT NULL,
	CONSTRAINT `dataset_rows_id` PRIMARY KEY(`id`),
	CONSTRAINT `dataset_row_index_unq` UNIQUE(`datasetId`,`rowIndex`)
);
--> statement-breakpoint
CREATE TABLE `pipeline_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`pipelineId` int NOT NULL,
	`status` varchar(32) NOT NULL,
	`rowsIn` int NOT NULL DEFAULT 0,
	`rowsOut` int NOT NULL DEFAULT 0,
	`coercionFailures` int NOT NULL DEFAULT 0,
	`durationMs` int NOT NULL DEFAULT 0,
	`errorMessage` text,
	`logs` json,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `pipeline_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `pipeline_steps` (
	`id` int AUTO_INCREMENT NOT NULL,
	`pipelineId` int NOT NULL,
	`stepOrder` int NOT NULL,
	`operation` varchar(32) NOT NULL,
	`config` json NOT NULL,
	CONSTRAINT `pipeline_steps_id` PRIMARY KEY(`id`),
	CONSTRAINT `pipeline_step_order_unq` UNIQUE(`pipelineId`,`stepOrder`)
);
--> statement-breakpoint
ALTER TABLE `pipelines` ADD `sourceDatasetId` int;--> statement-breakpoint
ALTER TABLE `pipelines` ADD `destinationMode` varchar(32);--> statement-breakpoint
ALTER TABLE `pipelines` ADD `destinationDatasetId` int;--> statement-breakpoint
ALTER TABLE `pipelines` ADD `successRate` int;--> statement-breakpoint
ALTER TABLE `pipelines` ADD `avgDurationSeconds` int;--> statement-breakpoint
ALTER TABLE `pipelines` ADD `failureCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pipelines` ADD `dag` json;