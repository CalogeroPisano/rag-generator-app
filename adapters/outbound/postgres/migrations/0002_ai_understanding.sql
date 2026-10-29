CREATE SCHEMA "rag";
--> statement-breakpoint
CREATE TABLE "model_call" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid,
	"snapshot_id" uuid,
	"phase" text NOT NULL,
	"task" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"attempt" integer NOT NULL,
	"outcome" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_call_outcome_check" CHECK ("model_call"."outcome" in ('success', 'invalid_output', 'error', 'timeout'))
);
--> statement-breakpoint
CREATE TABLE "rag"."card" (
	"id" uuid PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"feature_id" uuid NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"content" jsonb NOT NULL,
	"source_revision" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"unreferenced_statements" integer DEFAULT 0 NOT NULL,
	"prompt_version" integer NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rag_card_status_check" CHECK ("rag"."card"."status" in ('generated', 'flagged', 'in_review', 'approved', 'excluded', 'needs_recheck'))
);
--> statement-breakpoint
CREATE TABLE "rag"."card_reference" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"card_id" uuid NOT NULL,
	"section" text NOT NULL,
	"item_index" integer NOT NULL,
	"claim" text NOT NULL,
	"path" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rag"."feature" (
	"id" uuid PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"files" text[] DEFAULT '{}'::text[] NOT NULL,
	"symbols" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompt_version" integer NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rag"."file_summary" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"path" text NOT NULL,
	"language" text NOT NULL,
	"content_hash" text NOT NULL,
	"summary" text NOT NULL,
	"parts" integer NOT NULL,
	"prompt_version" integer NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rag"."module_summary" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"path" text NOT NULL,
	"depth" integer NOT NULL,
	"summary" text NOT NULL,
	"file_count" integer NOT NULL,
	"prompt_version" integer NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rag"."snapshot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"project_name" text NOT NULL,
	"source_type" text NOT NULL,
	"repository_url" text,
	"revision" text NOT NULL,
	"language" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rag"."symbol_summary" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"path" text NOT NULL,
	"qualified_name" text NOT NULL,
	"kind" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"summary" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "snapshot" ADD COLUMN "understanding_status" text;--> statement-breakpoint
ALTER TABLE "snapshot" ADD COLUMN "understood_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "snapshot" ADD COLUMN "feature_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "snapshot" ADD COLUMN "card_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_call" ADD CONSTRAINT "model_call_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_call" ADD CONSTRAINT "model_call_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag"."card" ADD CONSTRAINT "card_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "rag"."snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag"."card" ADD CONSTRAINT "card_feature_id_feature_id_fk" FOREIGN KEY ("feature_id") REFERENCES "rag"."feature"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag"."card_reference" ADD CONSTRAINT "card_reference_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "rag"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag"."feature" ADD CONSTRAINT "feature_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "rag"."snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag"."file_summary" ADD CONSTRAINT "file_summary_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "rag"."snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag"."module_summary" ADD CONSTRAINT "module_summary_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "rag"."snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag"."symbol_summary" ADD CONSTRAINT "symbol_summary_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "rag"."snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_call_snapshot_idx" ON "model_call" USING btree ("snapshot_id","created_at");--> statement-breakpoint
CREATE INDEX "model_call_job_idx" ON "model_call" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rag_card_feature_idx" ON "rag"."card" USING btree ("feature_id");--> statement-breakpoint
CREATE INDEX "rag_card_snapshot_idx" ON "rag"."card" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "rag_card_reference_card_idx" ON "rag"."card_reference" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "rag_card_reference_path_idx" ON "rag"."card_reference" USING btree ("path");--> statement-breakpoint
CREATE INDEX "rag_feature_snapshot_idx" ON "rag"."feature" USING btree ("snapshot_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "rag_file_summary_path_idx" ON "rag"."file_summary" USING btree ("snapshot_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "rag_module_summary_path_idx" ON "rag"."module_summary" USING btree ("snapshot_id","path");--> statement-breakpoint
CREATE INDEX "rag_snapshot_project_idx" ON "rag"."snapshot" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "rag_symbol_summary_path_idx" ON "rag"."symbol_summary" USING btree ("snapshot_id","path");--> statement-breakpoint
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_understanding_status_check" CHECK ("snapshot"."understanding_status" is null or "snapshot"."understanding_status" in ('pending', 'running', 'ready', 'failed'));