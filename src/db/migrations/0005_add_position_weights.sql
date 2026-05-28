CREATE TABLE IF NOT EXISTS "position_weights" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "team_uuid" text NOT NULL,
  "weights" jsonb NOT NULL,
  "stat_weights" jsonb,
  "updated_at" timestamp DEFAULT now(),
  CONSTRAINT "position_weights_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "position_weights_user_team"
  ON "position_weights" USING btree ("user_id", "team_uuid");
