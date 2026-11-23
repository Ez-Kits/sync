CREATE TABLE `items` (
	`list_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `items_pk` PRIMARY KEY(`list_id`, `position`),
	CONSTRAINT `fk_items_list_id_lists_id_fk` FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `lists` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`created_at` integer DEFAULT 0
);
