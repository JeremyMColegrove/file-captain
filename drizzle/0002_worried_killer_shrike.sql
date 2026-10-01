CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "file_index_path_prefix_idx" ON "file_index" USING btree ("folder","path" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "file_index_name_trgm_idx" ON "file_index" USING gin ("name" gin_trgm_ops);