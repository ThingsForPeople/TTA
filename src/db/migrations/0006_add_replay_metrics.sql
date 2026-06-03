CREATE TABLE IF NOT EXISTS "replay_syncs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "team_uuid" text NOT NULL,
  "game_id" text NOT NULL,
  "completed_at" timestamp,
  "game_mode" text,
  "opponent_name" text,
  "synced_at" timestamp DEFAULT now(),
  CONSTRAINT "replay_syncs_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "replay_syncs_user_team_game"
  ON "replay_syncs" USING btree ("user_id", "team_uuid", "game_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "replay_syncs_user_team"
  ON "replay_syncs" USING btree ("user_id", "team_uuid");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "replay_metrics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "team_uuid" text NOT NULL,
  "game_id" text NOT NULL,
  "player_id" text NOT NULL,
  "player_name" text NOT NULL,
  "position" integer,
  "completed_at" timestamp,
  "game_mode" text,
  "metrics" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now(),
  CONSTRAINT "replay_metrics_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "replay_metrics_user_team_game_player"
  ON "replay_metrics" USING btree ("user_id", "team_uuid", "game_id", "player_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "replay_metrics_user_team"
  ON "replay_metrics" USING btree ("user_id", "team_uuid");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "replay_metrics_user_team_player"
  ON "replay_metrics" USING btree ("user_id", "team_uuid", "player_id");
