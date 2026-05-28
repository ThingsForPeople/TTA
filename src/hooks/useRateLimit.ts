import { useCallback, useEffect, useRef, useState } from 'react';

export interface RateLimitState {
  remaining: number | null;
  resetsAt: number | null;
  countdown: string | null;
}

export function readRateLimitHeaders(res: Response): { remaining: number; resetsAt: number } | null {
  const rem = res.headers.get('X-RateLimit-Remaining');
  const reset = res.headers.get('X-RateLimit-Reset');
  if (rem === null || reset === null) return null;
  return { remaining: parseInt(rem, 10), resetsAt: parseInt(reset, 10) };
}

export function readRateLimitBody(body: { remaining?: number; resetsAt?: number }): { remaining: number; resetsAt: number } | null {
  if (typeof body.remaining !== 'number' || typeof body.resetsAt !== 'number') return null;
  return { remaining: body.remaining, resetsAt: body.resetsAt };
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '';
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

export function useRateLimit(): [RateLimitState, (info: { remaining: number; resetsAt: number }) => void] {
  const [remaining, setRemaining] = useState<number | null>(null);
  const [resetsAt, setResetsAt] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  const update = useCallback((info: { remaining: number; resetsAt: number }) => {
    setRemaining(info.remaining);
    setResetsAt(info.resetsAt);
  }, []);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);

    if (remaining !== null && remaining <= 0 && resetsAt !== null) {
      const tick = () => {
        const diff = resetsAt - Date.now();
        if (diff <= 0) {
          setCountdown(null);
          setRemaining(null);
          setResetsAt(null);
          if (timerRef.current) clearInterval(timerRef.current);
        } else {
          setCountdown(formatCountdown(diff));
        }
      };
      tick();
      timerRef.current = setInterval(tick, 1000);
    } else {
      setCountdown(null);
    }

    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [remaining, resetsAt]);

  return [{ remaining, resetsAt, countdown }, update];
}
