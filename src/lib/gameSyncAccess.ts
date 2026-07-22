import { authDisabled } from './auth';

// Access gate for the game-account sync feature. This feature lets a user hand
// their Tiny Teams password to the server (exchanged for a stored token), so on
// the multi-user deployment it's restricted to an explicit allowlist rather
// than exposed to everyone.
//
// GAME_SYNC_ALLOWED_EMAILS = comma-separated emails (edit in Vercel any time).
//   • Local dev (the dev server, or an explicitly auth-disabled instance) is
//     always allowed — it's your own single-user setup, regardless of whether
//     Clerk is wired up locally.
//   • If the var is unset/empty in a real auth deployment, NO ONE is allowed
//     (fail closed), so the feature can't be accidentally exposed.
export async function isGameSyncAllowed(): Promise<boolean> {
  if (authDisabled || process.env.NODE_ENV === 'development') return true;

  const allowed = (process.env.GAME_SYNC_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return false;

  const { currentUser } = await import('@clerk/nextjs/server');
  const user = await currentUser();
  const emails = (user?.emailAddresses ?? []).map((e) => e.emailAddress?.toLowerCase()).filter(Boolean);
  return emails.some((e) => allowed.includes(e!));
}
