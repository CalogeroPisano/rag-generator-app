ALTER TABLE "rag"."feature" ADD COLUMN "user_facing" double precision;--> statement-breakpoint
ALTER TABLE "rag"."feature" ADD COLUMN "technical" boolean DEFAULT false NOT NULL;