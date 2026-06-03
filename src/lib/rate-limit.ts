import { and, eq, gte, sql } from 'drizzle-orm';
import { db, hasDb } from '@/db';
import { usage, users } from '@/db/schema';

const WINDOW_MS = 60 * 60 * 1000; // 1 hour

const LIMITS: Record<string, number> = {
  insight: 3,
  recruit: 3,
  'talent-advisor': 5,
  'game-analysis': 10,     // single-game AI analysis (one model call each)
  'matchup-analysis': 5,   // multi-game AI analysis (heavier: also fetches several replays)
};

// Fail CLOSED: any action that reaches here without an explicit limit still gets
// a conservative cap, so a new/allowlisted action can never be silently unlimited.
const DEFAULT_LIMIT = 5;

export interface RateLimitResult {
  ok: boolean;
  message?: string;
  remaining: number;
  resetsAt: number;
}

export async function checkRateLimit(
  userId: string,
  teamUuid: string,
  actionType: string,
  userInfo?: { email?: string | null; name?: string | null },
): Promise<RateLimitResult> {
  const limit = LIMITS[actionType] ?? DEFAULT_LIMIT;
  const windowStart = new Date(Date.now() - WINDOW_MS);
  const resetsAt = Date.now() + WINDOW_MS;

  if (process.env.NODE_ENV === 'development' || !hasDb()) {
    return { ok: true, remaining: limit, resetsAt };
  }

  const [result] = await db
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<string>`min(used_at)`,
    })
    .from(usage)
    .where(
      and(
        eq(usage.userId, userId),
        eq(usage.actionType, actionType),
        gte(usage.usedAt, windowStart),
      ),
    );

  const used = result?.count ?? 0;
  const oldestTime = result?.oldest ? new Date(result.oldest).getTime() : Date.now();
  const actualResetsAt = used >= limit ? oldestTime + WINDOW_MS : resetsAt;

  if (used >= limit) {
    return {
      ok: false,
      message: `Limit reached (${limit}/hour). Try again soon.`,
      remaining: 0,
      resetsAt: actualResetsAt,
    };
  }

  await db
    .insert(users)
    .values({ id: userId, email: userInfo?.email ?? null, name: userInfo?.name ?? null })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        ...(userInfo?.email ? { email: userInfo.email } : {}),
        ...(userInfo?.name ? { name: userInfo.name } : {}),
        updatedAt: new Date(),
      },
    });
  await db.insert(usage).values({ userId, teamUuid, actionType });
  return { ok: true, remaining: limit - used - 1, resetsAt: actualResetsAt };
}
