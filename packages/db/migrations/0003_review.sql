CREATE TABLE "rag"."card_verification" (
	"card_id" uuid PRIMARY KEY NOT NULL,
	"card_version" integer NOT NULL,
	"statements" jsonb NOT NULL,
	"missing" jsonb NOT NULL,
	"issues" integer NOT NULL,
	"prompt_version" integer NOT NULL,
	"model" text NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rag"."correction" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"feature_id" uuid,
	"feature_name" text NOT NULL,
	"feature_key" text NOT NULL,
	"text" text NOT NULL,
	"author_id" text NOT NULL,
	"author_name" text NOT NULL,
	"applied_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "rag"."card" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "rag"."card" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rag"."card_verification" ADD CONSTRAINT "card_verification_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "rag"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag"."correction" ADD CONSTRAINT "correction_feature_id_feature_id_fk" FOREIGN KEY ("feature_id") REFERENCES "rag"."feature"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rag_correction_project_idx" ON "rag"."correction" USING btree ("project_id","feature_key");--> statement-breakpoint
CREATE INDEX "rag_correction_feature_idx" ON "rag"."correction" USING btree ("feature_id");