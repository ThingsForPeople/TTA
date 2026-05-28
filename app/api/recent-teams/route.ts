import { getUser } from '@/lib/auth';
import { desc, eq } from 'drizzle-orm';
import { db, hasDb } from '@/db';
import { recentTeams } from '@/db/schema';

const MAX_RECENT = 10;

export async function GET() {
  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  if (!hasDb()) return Response.json([]);

  const rows = await db.query.recentTeams.findMany({
    where: eq(recentTeams.userId, userId),
    orderBy: [desc(recentTeams.lastViewed)],
    limit: MAX_RECENT,
  });

  return Response.json(
    rows.map((r) => ({
      uuid: r.teamUuid,
      name: r.teamName,
      lastViewed: r.lastViewed?.getTime() ?? Date.now(),
    })),
  );
}

export async function POST(req: Request) {
  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  if (!hasDb()) return Response.json({ ok: true });

  const body = await req.json() as { uuid: string; name: string };
  if (!body.uuid || !body.name) {
    return Response.json({ error: 'Missing uuid or name' }, { status: 400 });
  }

  await db
    .insert(recentTeams)
    .values({
      userId,
      teamUuid: body.uuid,
      teamName: body.name,
      lastViewed: new Date(),
    })
    .onConflictDoUpdate({
      target: [recentTeams.userId, recentTeams.teamUuid],
      set: {
        teamName: body.name,
        lastViewed: new Date(),
      },
    });

  return Response.json({ ok: true });
}
