ALTER TABLE "player_meta" ADD COLUMN "injury" jsonb;
ALTER TABLE "player_meta" ADD COLUMN "injury_history" jsonb;
ALTER TABLE "player_meta" DROP COLUMN IF EXISTS "position";
