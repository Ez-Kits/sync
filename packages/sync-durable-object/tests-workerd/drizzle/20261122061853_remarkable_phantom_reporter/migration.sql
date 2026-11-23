CREATE TABLE `notes` (
	`id` text PRIMARY KEY,
	`list_id` text NOT NULL,
	`position` integer NOT NULL,
	`body` text NOT NULL,
	CONSTRAINT `fk_notes_list_id_position_items_list_id_position_fk` FOREIGN KEY (`list_id`,`position`) REFERENCES `items`(`list_id`,`position`) ON DELETE CASCADE
);
