import { getUser } from '@/lib/auth';
import { and, eq, desc } from 'drizzle-orm';
import { db, hasDb } from '@/db';
import { statHistory } from '@/db/schema';

const TRAINING_TICK_HOUR_UTC = 14; // 10 AM EST = 14:00 UTC

function trainingDayKey(ts: number): number {
  const d = new Date(ts);
  const utcHours = d.getUTCHours();
  const utcDate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (utcHours < TRAINING_TICK_HOUR_UTC) utcDate.setUTCDate(utcDate.getUTCDate() - 1);
  return utcDate.getTime();
}

export async function GET(req: Request) {
  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  if (!hasDb()) return Response.json([]);

  const { searchParams } = new URL(req.url);
  const playerUuid = searchParams.get('playerUuid');

  const rows = await db.query.statHistory.findMany({
    where: playerUuid
      ? and(eq(statHistory.userId, userId), eq(statHistory.playerUuid, playerUuid))
      : eq(statHistory.userId, userId),
    orderBy: [desc(statHistory.recordedAt)],
  });

  return Response.json(rows);
}

export async function POST(req: Request) {
  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  if (!hasDb()) return Response.json({ ok: true });

  const body = await req.json() as {
    playerUuid: string;
    sim: { con: number; pow: number; spd: number; fld: number; arm: number; pit: number; sta: number };
    ovr: number;
    timestamp?: number;
  };

  if (!body.playerUuid || !body.sim || body.ovr == null) {
    return Response.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const latest = await db.query.statHistory.findFirst({
    where: and(
      eq(statHistory.userId, userId),
      eq(statHistory.playerUuid, body.playerUuid),
    ),
    orderBy: [desc(statHistory.recordedAt)],
  });

  const recordedAt = body.timestamp ? new Date(body.timestamp) : new Date();

  if (latest?.recordedAt) {
    const sameTrainingDay = trainingDayKey(recordedAt.getTime()) === trainingDayKey(latest.recordedAt.getTime());
    if (sameTrainingDay) {
      await db
        .update(statHistory)
        .set({ sim: body.sim, ovr: body.ovr, recordedAt })
        .where(eq(statHistory.id, latest.id));
      return Response.json({ ok: true, merged: true });
    }
  }

  await db.insert(statHistory).values({
    userId,
    playerUuid: body.playerUuid,
    sim: body.sim,
    ovr: body.ovr,
    recordedAt,
  });

  return Response.json({ ok: true, merged: false });
}
