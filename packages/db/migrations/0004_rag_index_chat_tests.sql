CREATE TABLE "chat_conversation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"status" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"citations" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"snapshot_id" uuid,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_message_role_check" CHECK ("chat_message"."role" in ('user', 'assistant')),
	CONSTRAINT "chat_message_status_check" CHECK ("chat_message"."status" in ('complete', 'failed', 'interrupted'))
);
--> statement-breakpoint
CREATE TABLE "rag"."chunk" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"card_version" integer NOT NULL,
	"section" text NOT NULL,
	"text" text NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "text")) STORED NOT NULL,
	"embedding" vector NOT NULL,
	"dimensions" integer NOT NULL,
	"model" text NOT NULL,
	"format_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rag"."test_question" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"feature_id" uuid,
	"feature_name" text NOT NULL,
	"feature_key" text NOT NULL,
	"question" text NOT NULL,
	"expected_answer" text,
	"origin" text NOT NULL,
	"author_name" text,
	"model" text,
	"prompt_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rag_test_question_origin_check" CHECK ("rag"."test_question"."origin" in ('generated', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "rag"."test_result" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"question" text NOT NULL,
	"expected_feature_id" uuid NOT NULL,
	"expected_feature_name" text NOT NULL,
	"retrieved" jsonb NOT NULL,
	"rank" integer,
	"answer" text NOT NULL,
	"cited_feature_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"verdict" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rag_test_result_verdict_check" CHECK ("rag"."test_result"."verdict" is null or "rag"."test_result"."verdict" in ('correct', 'partial', 'incorrect', 'no_answer'))
);
--> statement-breakpoint
CREATE TABLE "rag"."test_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"status" text NOT NULL,
	"model" text NOT NULL,
	"embedding_model" text NOT NULL,
	"top_k" integer NOT NULL,
	"approved_only" boolean NOT NULL,
	"questions" integer NOT NULL,
	"retrieval_hits" integer DEFAULT 0 NOT NULL,
	"first_hits" integer DEFAULT 0 NOT NULL,
	"mrr" double precision DEFAULT 0 NOT NULL,
	"correct" integer DEFAULT 0 NOT NULL,
	"partial" integer DEFAULT 0 NOT NULL,
	"incorrect" integer DEFAULT 0 NOT NULL,
	"no_answer" integer DEFAULT 0 NOT NULL,
	"unjudged" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "rag_test_run_status_check" CHECK ("rag"."test_run"."status" in ('running', 'ready', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "chat_conversation" ADD CONSTRAINT "chat_conversation_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversation" ADD CONSTRAINT "chat_conversation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_conversation_id_chat_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag"."chunk" ADD CONSTRAINT "chunk_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "rag"."snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag"."chunk" ADD CONSTRAINT "chunk_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "rag"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag"."test_question" ADD CONSTRAINT "test_question_feature_id_feature_id_fk" FOREIGN KEY ("feature_id") REFERENCES "rag"."feature"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag"."test_result" ADD CONSTRAINT "test_result_run_id_test_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "rag"."test_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag"."test_run" ADD CONSTRAINT "test_run_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "rag"."snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_conversation_user_idx" ON "chat_conversation" USING btree ("project_id","user_id","updated_at");--> statement-breakpoint
CREATE INDEX "chat_message_conversation_idx" ON "chat_message" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "rag_chunk_card_idx" ON "rag"."chunk" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "rag_chunk_snapshot_model_idx" ON "rag"."chunk" USING btree ("snapshot_id","model");--> statement-breakpoint
CREATE INDEX "rag_chunk_search_idx" ON "rag"."chunk" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "rag_test_question_project_idx" ON "rag"."test_question" USING btree ("project_id","feature_key");--> statement-breakpoint
CREATE INDEX "rag_test_question_feature_idx" ON "rag"."test_question" USING btree ("feature_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rag_test_result_question_idx" ON "rag"."test_result" USING btree ("run_id","question_id");--> statement-breakpoint
CREATE INDEX "rag_test_run_snapshot_idx" ON "rag"."test_run" USING btree ("snapshot_id","started_at");