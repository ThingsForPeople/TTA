CREATE TABLE IF NOT EXISTS "recent_teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"team_uuid" text NOT NULL,
	"team_name" text NOT NULL,
	"last_viewed" timestamp DEFAULT now(),
	CONSTRAINT "recent_teams_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action
);

CREATE UNIQUE INDEX IF NOT EXISTS "recent_teams_user_team" ON "recent_teams" USING btree ("user_id","team_uuid");
CREATE INDEX IF NOT EXISTS "recent_teams_user_viewed" ON "recent_teams" USING btree ("user_id","last_viewed");
