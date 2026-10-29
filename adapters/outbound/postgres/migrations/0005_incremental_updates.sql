ALTER TABLE "project" ADD COLUMN "current_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "snapshot" ADD COLUMN "base_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "snapshot" ADD COLUMN "changes" jsonb;--> statement-breakpoint
ALTER TABLE "rag"."card" ADD COLUMN "change" text;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_current_snapshot_id_snapshot_id_fk" FOREIGN KEY ("current_snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_base_snapshot_id_snapshot_id_fk" FOREIGN KEY ("base_snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag"."card" ADD CONSTRAINT "rag_card_change_check" CHECK ("rag"."card"."change" is null or "rag"."card"."change" in ('kept', 'updated', 'created'));--> statement-breakpoint
-- Existing projects have a single version: it becomes the current one.
UPDATE "project" p SET "current_snapshot_id" = (
  SELECT s."id" FROM "snapshot" s WHERE s."project_id" = p."id" ORDER BY s."created_at" DESC LIMIT 1
);
