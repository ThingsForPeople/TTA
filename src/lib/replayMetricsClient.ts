// Session-scoped memo for /replay-metrics fetches. Several components request
// the same aggregate independently (field-positions optimizer, platoon splits,
// talent advisor, the Advanced Stats/Batting panels), and each server-side call
// is a full Neon read — memoizing by URL collapses the duplicates and makes
// repeat filter flips free. Keyed by full URL (so distinct filter combos cache
// separately); in-flight requests share one promise. Invalidate after a sync
// or clear mutates the underlying data.
const cache = new Map<string, Promise<unknown>>();

export function fetchReplayMetrics<T = unknown>(teamUuid: string, qs = ''): Promise<T | null> {
  const url = `/api/team/${teamUuid}/replay-metrics${qs ? `?${qs}` : ''}`;
  let p = cache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((json) => {
        // Don't memoize failures — the next caller should retry.
        if (json === null) cache.delete(url);
        return json;
      });
    cache.set(url, p);
  }
  return p as Promise<T | null>;
}

export function invalidateReplayMetrics(teamUuid: string) {
  const prefix = `/api/team/${teamUuid}/replay-metrics`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
