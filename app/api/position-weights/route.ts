import { getUser } from '@/lib/auth';
import { and, eq } from 'drizzle-orm';
import { db, hasDb } from '@/db';
import { positionWeights, users } from '@/db/schema';
import { DEFAULT_POSITION_IMPORTANCE, DEFAULT_STAT_WEIGHTS } from '@/lib/rosterOptimizer';

const POSITIONS = ['SS', 'CF', '2B', '3B', 'RF', 'LF', 'C', '1B'] as const;
const STATS = ['fld', 'arm', 'spd'] as const;

interface WeightsResponse {
  weights: Record<string, number>;
  statWeights: Record<string, Record<string, number>>;
  isDefault: boolean;
}

const DEFAULT_RESPONSE: WeightsResponse = {
  weights: DEFAULT_POSITION_IMPORTANCE,
  statWeights: DEFAULT_STAT_WEIGHTS,
  isDefault: true,
};

function buildResponse(row: { weights: Record<string, number>; statWeights?: Record<string, Record<string, number>> | null }): WeightsResponse {
  return {
    weights: row.weights,
    statWeights: row.statWeights ?? DEFAULT_STAT_WEIGHTS,
    isDefault: false,
  };
}

export async function GET(req: Request) {
  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const { searchParams } = new URL(req.url);
  const teamUuid = searchParams.get('teamUuid');
  if (!teamUuid) return Response.json({ error: 'Missing teamUuid' }, { status: 400 });

  if (!hasDb()) return Response.json(DEFAULT_RESPONSE);

  const row = await db.query.positionWeights.findFirst({
    where: and(eq(positionWeights.userId, userId), eq(positionWeights.teamUuid, teamUuid)),
  });
  if (row) return Response.json(buildResponse(row));

  return Response.json(DEFAULT_RESPONSE);
}

export async function PUT(req: Request) {
  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  if (!hasDb()) return Response.json({ ok: true });

  const body = await req.json() as {
    teamUuid: string;
    weights: Record<string, number>;
    statWeights?: Record<string, Record<string, number>>;
  };

  if (!body.teamUuid || !body.weights) {
    return Response.json({ error: 'Missing required fields' }, { status: 400 });
  }

  for (const pos of POSITIONS) {
    const val = body.weights[pos];
    if (typeof val !== 'number' || val < 0 || val > 2) {
      return Response.json({ error: `Invalid weight for ${pos}: must be 0–2` }, { status: 400 });
    }
  }

  if (body.statWeights) {
    for (const pos of POSITIONS) {
      const sw = body.statWeights[pos];
      if (!sw) continue;
      for (const stat of STATS) {
        const val = sw[stat];
        if (val !== undefined && (typeof val !== 'number' || val < 0 || val > 1)) {
          return Response.json({ error: `Invalid stat weight ${stat} for ${pos}: must be 0–1` }, { status: 400 });
        }
      }
    }
  }

  await db.insert(users).values({ id: userId }).onConflictDoNothing();

  await db
    .insert(positionWeights)
    .values({
      userId,
      teamUuid: body.teamUuid,
      weights: body.weights,
      statWeights: body.statWeights ?? null,
    })
    .onConflictDoUpdate({
      target: [positionWeights.userId, positionWeights.teamUuid],
      set: {
        weights: body.weights,
        statWeights: body.statWeights ?? null,
        updatedAt: new Date(),
      },
    });

  return Response.json({ ok: true });
}

export async function DELETE(req: Request) {
  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  if (!hasDb()) return Response.json({ ok: true });

  const { searchParams } = new URL(req.url);
  const teamUuid = searchParams.get('teamUuid');
  if (!teamUuid) return Response.json({ error: 'Missing teamUuid' }, { status: 400 });

  await db
    .delete(positionWeights)
    .where(and(eq(positionWeights.userId, userId), eq(positionWeights.teamUuid, teamUuid)));

  return Response.json({ ok: true });
}
