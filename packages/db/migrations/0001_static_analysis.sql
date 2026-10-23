CREATE TABLE "file_dependency" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"file_id" bigint NOT NULL,
	"specifier" text NOT NULL,
	"kind" text NOT NULL,
	"line" integer NOT NULL,
	"names" text[] DEFAULT '{}'::text[] NOT NULL,
	"target_kind" text NOT NULL,
	"target_file_id" bigint,
	"target_path" text,
	"external_name" text,
	CONSTRAINT "file_dependency_target_kind_check" CHECK ("file_dependency"."target_kind" in ('pending', 'file', 'directory', 'namespace', 'external', 'unresolved'))
);
--> statement-breakpoint
CREATE TABLE "symbol" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"file_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"qualified_name" text NOT NULL,
	"container" text,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"exported" boolean NOT NULL,
	"signature" text NOT NULL,
	"doc" text
);
--> statement-breakpoint
ALTER TABLE "snapshot" ADD COLUMN "analysis_status" text;--> statement-breakpoint
ALTER TABLE "snapshot" ADD COLUMN "analyzer_version" text;--> statement-breakpoint
ALTER TABLE "snapshot" ADD COLUMN "analyzed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "snapshot" ADD COLUMN "symbol_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "snapshot" ADD COLUMN "dependency_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_file" ADD COLUMN "package_name" text;--> statement-breakpoint
ALTER TABLE "source_file" ADD COLUMN "parse_errors" integer;--> statement-breakpoint
ALTER TABLE "file_dependency" ADD CONSTRAINT "file_dependency_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_dependency" ADD CONSTRAINT "file_dependency_file_id_source_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."source_file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_dependency" ADD CONSTRAINT "file_dependency_target_file_id_source_file_id_fk" FOREIGN KEY ("target_file_id") REFERENCES "public"."source_file"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symbol" ADD CONSTRAINT "symbol_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symbol" ADD CONSTRAINT "symbol_file_id_source_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."source_file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_dependency_file_idx" ON "file_dependency" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "file_dependency_target_file_idx" ON "file_dependency" USING btree ("target_file_id");--> statement-breakpoint
CREATE INDEX "file_dependency_snapshot_kind_idx" ON "file_dependency" USING btree ("snapshot_id","target_kind");--> statement-breakpoint
CREATE INDEX "symbol_file_idx" ON "symbol" USING btree ("file_id","start_line");--> statement-breakpoint
CREATE INDEX "symbol_snapshot_name_idx" ON "symbol" USING btree ("snapshot_id","name");--> statement-breakpoint
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_analysis_status_check" CHECK ("snapshot"."analysis_status" is null or "snapshot"."analysis_status" in ('pending', 'running', 'ready', 'failed'));