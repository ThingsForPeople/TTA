import type { RateLimitState } from '../hooks/useRateLimit';

export function RateLimitBadge({ state, banner }: { state: RateLimitState; banner?: boolean }) {
  if (state.remaining === null) return null;

  if (state.countdown) {
    if (banner) {
      return (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <span className="font-semibold">Rate limit reached.</span>{' '}
          You can use this again in <span className="font-mono font-bold text-amber-300">{state.countdown}</span>
        </div>
      );
    }
    return (
      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
        resets in {state.countdown}
      </span>
    );
  }

  if (state.remaining !== null && state.remaining <= 1) {
    return (
      <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">
        {state.remaining} remaining
      </span>
    );
  }

  return (
    <span className="text-[10px] text-slate-500">
      {state.remaining} remaining
    </span>
  );
}
