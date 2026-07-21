CREATE TABLE IF NOT EXISTS "game_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "label" text NOT NULL,
  "refresh_token_enc" text NOT NULL,
  "last_synced_at" timestamp,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "game_accounts_user" ON "game_accounts" ("user_id");
