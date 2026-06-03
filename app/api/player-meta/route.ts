import { getUser } from '@/lib/auth';
import { and, eq } from 'drizzle-orm';
import { db, hasDb } from '@/db';
import { playerMeta, users } from '@/db/schema';

export async function GET(req: Request) {
  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  if (!hasDb()) return Response.json({});

  const { searchParams } = new URL(req.url);
  const teamPlayerUuids = searchParams.get('playerUuids');

  let rows = await db.query.playerMeta.findMany({
    where: eq(playerMeta.userId, userId),
  });

  if (teamPlayerUuids) {
    const uuids = teamPlayerUuids.split(',');
    rows = rows.filter((r) => uuids.includes(r.playerUuid));
  }

  const store: Record<string, {
    sim: typeof rows[0]['sim'];
    talents: typeof rows[0]['talents'];
    talentLevels: typeof rows[0]['talentLevels'];
    injury?: typeof rows[0]['injury'];
    injuryHistory?: typeof rows[0]['injuryHistory'];
    pitchTalents?: typeof rows[0]['pitchTalents'];
    bats?: 'R' | 'L';
    throws?: 'R' | 'L';
    archetype?: string;
    age?: number;
  }> = {};

  for (const row of rows) {
    store[row.playerUuid] = {
      sim: row.sim,
      talents: row.talents,
      talentLevels: row.talentLevels,
      injury: row.injury ?? undefined,
      injuryHistory: row.injuryHistory ?? undefined,
      pitchTalents: row.pitchTalents ?? undefined,
      bats: row.bats ?? undefined,
      throws: row.throws ?? undefined,
      archetype: row.archetype ?? undefined,
      age: row.age ?? undefined,
    };
  }

  return Response.json(store);
}

export async function PUT(req: Request) {
  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  if (!hasDb()) return Response.json({ ok: true });

  const body = await req.json() as {
    playerUuid: string;
    sim: { con: number; pow: number; spd: number; fld: number; arm: number; pit: number; sta: number };
    talents: string[];
    talentLevels?: Record<string, number>;
    injury?: { severity: 'minor' | 'major' | 'catastrophic'; date: number; note?: string } | null;
    injuryHistory?: { severity: 'minor' | 'major' | 'catastrophic'; date: number; resolvedDate?: number; note?: string }[];
    pitchTalents?: { pitch: string; level: number; sub: { name: string; level: number }[] }[];
    bats?: 'R' | 'L' | null;
    throws?: 'R' | 'L' | null;
    archetype?: string | null;
    age?: number | null;
  };

  if (!body.playerUuid || !body.sim || !body.talents) {
    return Response.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const simKeys = ['con', 'pow', 'spd', 'fld', 'arm', 'pit', 'sta'] as const;
  const simValues = simKeys.map((k) => body.sim[k]);
  const nonZero = simValues.filter((v) => v > 0);
  if (nonZero.length > 0) {
    const max = Math.max(...nonZero);
    const hasTruncated = nonZero.some((v) => v < 10 && max >= 20);
    if (hasTruncated) {
      const existing = await db.query.playerMeta.findFirst({
        where: and(eq(playerMeta.userId, userId), eq(playerMeta.playerUuid, body.playerUuid)),
      });
      if (existing) {
        const existingValues = simKeys.map((k) => (existing.sim as Record<string, number>)[k]);
        const existingNonZero = existingValues.filter((v) => v > 0);
        const existingMax = existingNonZero.length > 0 ? Math.max(...existingNonZero) : 0;
        if (existingMax >= 20) {
          return Response.json(
            { error: 'Stat value looks truncated — a single-digit stat alongside much higher values is likely a partial keystroke. Please re-enter.' },
            { status: 422 },
          );
        }
      }
    }
  }

  await db
    .insert(users)
    .values({ id: userId })
    .onConflictDoNothing();

  await db
    .insert(playerMeta)
    .values({
      userId,
      playerUuid: body.playerUuid,
      sim: body.sim,
      talents: body.talents,
      talentLevels: body.talentLevels ?? {},
      injury: body.injury ?? null,
      injuryHistory: body.injuryHistory ?? [],
      pitchTalents: body.pitchTalents ?? [],
      bats: body.bats ?? null,
      throws: body.throws ?? null,
      archetype: body.archetype ?? null,
      age: body.age ?? null,
    })
    .onConflictDoUpdate({
      target: [playerMeta.userId, playerMeta.playerUuid],
      set: {
        sim: body.sim,
        talents: body.talents,
        talentLevels: body.talentLevels ?? {},
        injury: body.injury ?? null,
        injuryHistory: body.injuryHistory ?? [],
        pitchTalents: body.pitchTalents ?? [],
        bats: body.bats ?? null,
        throws: body.throws ?? null,
        archetype: body.archetype ?? null,
        age: body.age ?? null,
        updatedAt: new Date(),
      },
    });

  return Response.json({ ok: true });
}
