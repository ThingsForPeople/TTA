// Client for the Tiny Teams PRIVATE game API (api.tiny-teams.com/v1). This is
// the authenticated backend the mobile app uses — it exposes exact player
// attributes (contact/power/…), age, handedness, injuries and talents that the
// public team-search scrape does NOT. We use it only for a user's OWN account:
// the token is manager-scoped (reading a team you don't own returns "you do not
// own this team"), so this cannot reach other players' private data.
//
// Auth: POST /v1/auth/login {email,password} -> {accessToken, refreshToken,
// expiresIn(3600)}. Access tokens are short-lived; POST /v1/auth/refresh
// {refreshToken} mints a new pair (the refresh token rotates — persist the new
// one). All reads take `Authorization: Bearer <accessToken>`.

const API = 'https://api.tiny-teams.com';

export interface GameTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export class GameAuthError extends Error {}

export async function login(email: string, password: string): Promise<GameTokens> {
  const res = await fetch(`${API}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    // 400 = missing fields, 401 = invalid credentials.
    throw new GameAuthError(res.status === 401 ? 'Invalid email or password.' : `Login failed (${res.status}).`);
  }
  const body = await res.json();
  if (!body.accessToken || !body.refreshToken) throw new GameAuthError('Login response missing tokens.');
  return { accessToken: body.accessToken, refreshToken: body.refreshToken, expiresIn: body.expiresIn ?? 3600 };
}

export async function refresh(refreshToken: string): Promise<GameTokens> {
  const res = await fetch(`${API}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) throw new GameAuthError('Stored session expired — reconnect this account.');
  const body = await res.json();
  if (!body.accessToken || !body.refreshToken) throw new GameAuthError('Refresh response missing tokens.');
  return { accessToken: body.accessToken, refreshToken: body.refreshToken, expiresIn: body.expiresIn ?? 3600 };
}

// --- Roster shapes (only the fields we consume) ---

export interface GameAttribute { currentValue: number; effectiveValue: number; potential: string }
export interface GameRosterPlayer {
  playerId: string;
  firstName: string;
  lastName: string;
  batHand: 'R' | 'L';
  throwHand: 'R' | 'L';
  age: number | null;
  archetype: string | null;
  injuryStatus: string | null;
  battingPosition: number | null;
  fieldingPosition: number | null;
  attributes: Record<string, GameAttribute>;
  talents?: { id: string; displayName: string; tier: number }[];
}
export interface GameRoster {
  teamId: string;
  teamName: string;
  players: GameRosterPlayer[];
}

export const OWNERSHIP_STATUS = 403; // "you do not own this team"

// Fetch an owned team's roster. Returns null on 401/403 (this token doesn't own
// the team — the caller tries the next connected account).
export async function fetchRoster(accessToken: string, teamUuid: string): Promise<GameRoster | null> {
  const res = await fetch(`${API}/v1/teams/${teamUuid}/roster`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new GameAuthError(`Roster fetch failed (${res.status}).`);
  return (await res.json()) as GameRoster;
}

// Map the game's attribute block to our sim-stat shape. We take currentValue
// (the true attribute); injury debuffs live in effectiveValue but we track
// injuries separately, so using currentValue avoids double-counting.
export interface SimStats { con: number; pow: number; spd: number; fld: number; arm: number; pit: number; sta: number }

const ATTR_TO_SIM: Record<string, keyof SimStats> = {
  contact: 'con',
  power: 'pow',
  speed: 'spd',
  fielding: 'fld',
  armStrength: 'arm',
  pitchingSkill: 'pit',
  stamina: 'sta',
};

export function mapSimStats(attributes: Record<string, GameAttribute>): SimStats {
  const sim: SimStats = { con: 0, pow: 0, spd: 0, fld: 0, arm: 0, pit: 0, sta: 0 };
  for (const [gameKey, simKey] of Object.entries(ATTR_TO_SIM)) {
    const v = attributes[gameKey]?.currentValue;
    if (typeof v === 'number') sim[simKey] = Math.round(v);
  }
  return sim;
}
