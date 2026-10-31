CREATE TABLE "app_admin" (
	"user_id" text PRIMARY KEY NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"body" jsonb NOT NULL,
	"sealed_keys" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "model_settings_single_row" CHECK ("model_settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "app_admin" ADD CONSTRAINT "app_admin_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;