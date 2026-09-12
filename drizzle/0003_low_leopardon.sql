CREATE TABLE `ingestion_attempts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspace_id` int NOT NULL,
	`dataset_name` varchar(160) NOT NULL,
	`source_type` varchar(80) NOT NULL,
	`status` varchar(32) NOT NULL,
	`rows_ingested` int NOT NULL DEFAULT 0,
	`created_by` int NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ingestion_attempts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `query_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`query_id` int NOT NULL,
	`workspace_id` int NOT NULL,
	`run_by` int NOT NULL,
	`row_count` int NOT NULL,
	`duration_ms` int NOT NULL,
	`run_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `query_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `recently_viewed` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`workspace_id` int NOT NULL,
	`entity_type` varchar(32) NOT NULL,
	`entity_id` varchar(64) NOT NULL,
	`entity_label` varchar(160) NOT NULL,
	`viewed_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `recently_viewed_id` PRIMARY KEY(`id`),
	CONSTRAINT `recently_viewed_user_entity_unq` UNIQUE(`user_id`,`workspace_id`,`entity_type`,`entity_id`)
);
--> statement-breakpoint
CREATE TABLE `saved_queries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspace_id` int NOT NULL,
	`dataset_id` int NOT NULL,
	`created_by` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`sql_text` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `saved_queries_id` PRIMARY KEY(`id`)
);
