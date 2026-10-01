CREATE TABLE "file_index" (
	"folder" text NOT NULL,
	"path" text NOT NULL,
	"parent" text NOT NULL,
	"name" text NOT NULL,
	"is_dir" boolean NOT NULL,
	"size" bigint NOT NULL,
	"mtime_ms" double precision NOT NULL,
	CONSTRAINT "file_index_folder_path_pk" PRIMARY KEY("folder","path")
);
--> statement-breakpoint
CREATE TABLE "folder_usage" (
	"folder" text PRIMARY KEY NOT NULL,
	"bytes" bigint NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
DROP TABLE "post" CASCADE;--> statement-breakpoint
CREATE INDEX "file_index_parent_idx" ON "file_index" USING btree ("folder","parent");