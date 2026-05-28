import { useCallback, useRef, useState } from 'react';
import { Markdown } from './Markdown';
import { RateLimitBadge } from './RateLimitBadge';
import { readRateLimitBody, readRateLimitHeaders, useRateLimit } from '../hooks/useRateLimit';

interface Props {
  buildContext: () => string;
  buildCompactContext: () => string;
  buildInsights: () => string;
  teamUuid?: string;
}

const PROMPT =
  'Analyze this team. Follow these rules strictly:\n\n' +
  'POSITION FIT (only flag MISMATCHES):\n' +
  '- SS/2B: FLD+SPD are primary. Flag players whose stats are notably low relative to others on the roster.\n' +
  '- CF: SPD is primary. Flag if clearly the weakest SPD option available.\n' +
  '- RF/3B: ARM is primary. Flag if ARM is weak relative to roster alternatives.\n' +
  '- C/1B/LF are BAT-FIRST — high POW/CON here is GOOD, not a problem. Only flag if they have elite defensive stats wasted at a bat-first spot.\n' +
  '- If fielding stats (FLD%, PO, A, E) are available, use error rates and fielding % to identify defensive liabilities or strengths. High errors at a premium position (SS, CF) is a red flag.\n' +
  '- Pitchers: ONLY PIT+STA matter. Ignore their ARM/FLD/SPD/CON/POW entirely.\n' +
  '- Compare players against EACH OTHER, not against fixed thresholds. There are no known stat breakpoints.\n\n' +
  'TALENTS: Only reference talents you can see in the data. Do NOT invent talent names. ' +
  'Pitch-type talents (Fastball, Cutter, etc.) are strengths for pitchers — do not suggest replacing a pitcher who has them.\n\n' +
  'Give 3-5 bullet points: position swaps that would improve fit, ' +
  'batting order changes, and 1-2 talent or training priorities. Be specific with names and numbers. ' +
  'Do NOT repeat raw stat lines or restate what each position needs.';

export function InsightsPanel({ buildContext, buildCompactContext, buildInsights, teamUuid }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'streaming' | 'done' | 'error'>('idle');
  const abortRef = useRef<AbortController | null>(null);
  const [rateLimit, updateRateLimit] = useRateLimit();

  const generate = useCallback(async () => {
    abortRef.current?.abort();
    setContent('');
    setStatus('streaming');

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/advise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: buildContext(),
          compactContext: buildCompactContext(),
          preComputedInsights: buildInsights(),
          question: PROMPT,
          history: [],
          teamUuid,
          actionType: 'insight',
        }),
        signal: controller.signal,
      });

      if (res.status === 429) {
        const body = await res.json();
        const info = readRateLimitBody(body);
        if (info) updateRateLimit(info);
        setContent(null);
        setStatus('error');
        return;
      }

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const rl = readRateLimitHeaders(res);
      if (rl) updateRateLimit(rl);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        setContent(buf);
      }
      setStatus('done');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : String(err);
      setContent((prev) => (prev || '') + `\n\n[error: ${msg}]`);
      setStatus('error');
    } finally {
      abortRef.current = null;
    }
  }, [buildContext, buildCompactContext, buildInsights, teamUuid, updateRateLimit]);

  const limited = rateLimit.remaining === 0 && !!rateLimit.countdown;

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
            Insights
          </h2>
          <RateLimitBadge state={rateLimit} />
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={status === 'streaming' || limited}
          className={
            'rounded-md border px-2 py-0.5 text-xs transition-colors ' +
            (status === 'streaming' || limited
              ? 'border-slate-700 text-slate-500 cursor-not-allowed'
              : 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/15')
          }
        >
          {status === 'streaming' ? 'generating…' : content !== null ? 'regenerate' : 'generate'}
        </button>
      </div>

      {limited && <RateLimitBadge state={rateLimit} banner />}

      {content !== null ? (
        <Markdown
          content={content || (status === 'streaming' ? 'thinking…' : '')}
          className="text-sm leading-relaxed text-slate-200"
        />
      ) : status !== 'error' ? (
        <p className="text-sm text-slate-500">
          Hit <span className="text-emerald-400">generate</span> to get AI-powered insights for the current roster and stats.
        </p>
      ) : null}
    </section>
  );
}
