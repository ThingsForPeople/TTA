CREATE TABLE "player_meta" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"player_uuid" text NOT NULL,
	"sim" jsonb NOT NULL,
	"talents" jsonb NOT NULL,
	"talent_levels" jsonb,
	"position" text,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "stat_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"player_uuid" text NOT NULL,
	"sim" jsonb NOT NULL,
	"ovr" integer NOT NULL,
	"recorded_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"team_uuid" text NOT NULL,
	"action_type" text NOT NULL,
	"used_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"name" text,
	"timezone" text DEFAULT 'America/New_York',
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "player_meta" ADD CONSTRAINT "player_meta_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_history" ADD CONSTRAINT "stat_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_meta_user_player" ON "player_meta" USING btree ("user_id","player_uuid");--> statement-breakpoint
CREATE INDEX "stat_history_user_player" ON "stat_history" USING btree ("user_id","player_uuid");--> statement-breakpoint
CREATE INDEX "usage_user_team_type" ON "usage" USING btree ("user_id","team_uuid","action_type");