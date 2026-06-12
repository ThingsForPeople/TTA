import { useCallback, useRef, useState } from 'react';
import { Markdown } from './Markdown';

// Default prompt for a SINGLE game. A multi-game caller can pass its own
// trends-oriented prompt via the `prompt` prop.
export const GAME_EVAL_PROMPT =
  'Evaluate this game for my team. Be concrete and reference player names + the numbers above.\n\n' +
  '1. WHAT WENT RIGHT — the 2-3 biggest positives. Favor PROCESS over results: hard contact, ' +
  'whiff-inducing pitches, strong defense, productive at-bats.\n' +
  '2. WHAT WENT WRONG — the 2-3 biggest negatives: chases/whiffs, mistake pitches that got hit, ' +
  'misplays, or hard contact allowed.\n' +
  '3. PROCESS vs RESULT — call out where the box score lies: our hard-hit balls that were caught ' +
  '(unlucky) or weak contact that fell in (lucky), so I don\'t over-react to the final line.\n' +
  '4. ONE TAKEAWAY — the single most useful adjustment, if any.\n\n' +
  'CRITICAL CONSTRAINT — the ONLY two things I can change between games are (a) the BATTING ORDER ' +
  '(who hits in which of the 9 slots) and (b) FIELD POSITIONING (which player plays which defensive ' +
  'position). Pitch execution is NOT correctable: I cannot change pitch selection/usage, location, ' +
  'a pitcher\'s arsenal, talents, sim stats, archetypes, or who starts. Mistake pitches may be NOTED ' +
  'in sections 1-3 as context for why runs scored, but never framed as something to fix — the takeaway ' +
  'in section 4 must be a batting-order or field-positioning move (or "no change warranted").\n\n' +
  'A single game is a tiny sample — do NOT over-read fielding PAE or one good/bad inning, and don\'t ' +
  'recommend roster overhauls off one game. Be concise — bullets, not paragraphs.';

interface Props {
  // Ready-to-send context (single game). Ignored if prepareContext is given.
  context?: string;
  // Async builder for the context (e.g. fetch + concat a subset of games'
  // replay evals). Awaited on click before the request is sent.
  prepareContext?: () => Promise<string>;
  teamUuid: string;
  prompt?: string;
  title?: string;
  // Rate-limit bucket (see LIMITS in rate-limit.ts).
  actionType?: string;
  // Optional copy shown before the user generates.
  hint?: string;
}

export function GameAiAnalysis({
  context,
  prepareContext,
  teamUuid,
  prompt = GAME_EVAL_PROMPT,
  title = 'AI game analysis',
  actionType = 'game-analysis',
  hint = 'Send this game’s data to the AI for a what-went-right / what-went-wrong read.',
}: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'preparing' | 'streaming' | 'done' | 'error'>('idle');
  const abortRef = useRef<AbortController | null>(null);

  const generate = useCallback(async () => {
    abortRef.current?.abort();
    setContent('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let ctx = context ?? '';
      if (prepareContext) {
        setStatus('preparing');
        ctx = await prepareContext();
      }
      if (!ctx) {
        setContent('[no game data to analyze for this selection]');
        setStatus('error');
        return;
      }
      setStatus('streaming');
      const res = await fetch('/api/advise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: ctx,
          compactContext: ctx,
          question: prompt,
          history: [],
          teamUuid,
          actionType,
        }),
        signal: controller.signal,
      });
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        setContent(body?.error || 'Rate limit reached — try again later.');
        setStatus('error');
        return;
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
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
  }, [context, prepareContext, prompt, teamUuid]);

  const busy = status === 'preparing' || status === 'streaming';

  return (
    <section className="rounded-md border border-sky-500/30 bg-sky-500/[0.03] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-sky-300/80">
          {title}
        </h3>
        <button
          type="button"
          onClick={generate}
          disabled={busy}
          className={
            'rounded-md border px-2 py-0.5 text-xs transition-colors ' +
            (busy
              ? 'border-slate-700 text-slate-500 cursor-not-allowed'
              : 'border-sky-500/40 text-sky-300 hover:bg-sky-500/15')
          }
        >
          {status === 'preparing' ? 'gathering games…' : status === 'streaming' ? 'analyzing…' : content !== null ? 'regenerate' : 'analyze'}
        </button>
      </div>
      {content !== null ? (
        <Markdown
          content={content || (busy ? 'thinking…' : '')}
          className="text-sm leading-relaxed text-slate-200"
        />
      ) : (
        <p className="text-xs text-slate-500">{hint}</p>
      )}
    </section>
  );
}
