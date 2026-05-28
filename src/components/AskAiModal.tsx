import { useCallback, useEffect, useRef, useState } from 'react';
import { Markdown } from './Markdown';
import { RateLimitBadge } from './RateLimitBadge';
import { readRateLimitBody, readRateLimitHeaders, useRateLimit } from '../hooks/useRateLimit';

interface Exchange {
  id: number;
  question: string;
  response: string;
  status: 'streaming' | 'done' | 'error';
}

interface Props {
  buildContext: () => string;
  buildCompactContext: () => string;
  teamUuid: string;
}

const PRESETS = [
  "Suggest a better lineup and explain your reasoning.",
  "What's this team's biggest weakness?",
  "Who should I bench, and who should replace them?",
];

export function AskAiModal({ buildContext, buildCompactContext, teamUuid }: Props) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const nextIdRef = useRef(1);
  const responseScrollRef = useRef<HTMLDivElement | null>(null);
  const [rateLimit, updateRateLimit] = useRateLimit();
  const limited = rateLimit.remaining === 0 && !!rateLimit.countdown;

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Cancel any in-flight request when the modal is closed mid-stream.
  useEffect(() => {
    if (!open && abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, [open]);

  // Scroll to bottom as a streaming response grows.
  useEffect(() => {
    if (responseScrollRef.current) {
      responseScrollRef.current.scrollTop = responseScrollRef.current.scrollHeight;
    }
  }, [exchanges]);

  const send = useCallback(
    async (q: string) => {
      const trimmed = q.trim();
      if (!trimmed || loading || limited) return;

      const id = nextIdRef.current++;
      setExchanges((prev) => [
        ...prev,
        { id, question: trimmed, response: '', status: 'streaming' },
      ]);
      setQuestion('');
      setLoading(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch('/api/advise', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context: buildContext(),
            compactContext: buildCompactContext(),
            question: trimmed,
            history: exchanges
              .filter((e) => e.status === 'done')
              .map((e) => ({ question: e.question, response: e.response })),
            teamUuid,
            actionType: 'insight',
          }),
          signal: controller.signal,
        });

        if (res.status === 429) {
          const body = await res.json();
          const info = readRateLimitBody(body);
          if (info) updateRateLimit(info);
          setExchanges((prev) =>
            prev.map((e) =>
              e.id === id
                ? { ...e, response: 'Rate limit reached. Please wait for the cooldown to expire before asking another question.', status: 'error' }
                : e,
            ),
          );
          return;
        }

        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        const rl = readRateLimitHeaders(res);
        if (rl) updateRateLimit(rl);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          setExchanges((prev) =>
            prev.map((e) =>
              e.id === id ? { ...e, response: e.response + chunk } : e,
            ),
          );
        }

        setExchanges((prev) =>
          prev.map((e) => (e.id === id ? { ...e, status: 'done' } : e)),
        );
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === 'AbortError';
        if (aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        setExchanges((prev) =>
          prev.map((e) =>
            e.id === id
              ? { ...e, response: e.response + `\n\n[error: ${message}]`, status: 'error' }
              : e,
          ),
        );
      } finally {
        setLoading(false);
        abortRef.current = null;
      }
    },
    [buildContext, buildCompactContext, teamUuid, loading, limited, updateRateLimit],
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-emerald-900/30 transition-colors hover:bg-emerald-500"
        aria-label="Ask AI"
      >
        <span aria-hidden="true">✦</span>
        Ask AI
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-6"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-2xl">
            <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-slate-100">Ask AI</h2>
                  <RateLimitBadge state={rateLimit} />
                </div>
                <p className="text-xs text-slate-500">
                  Ask anything about your team — roster, stats, and game context included automatically.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                aria-label="Close"
              >
                ✕
              </button>
            </header>

            <div
              ref={responseScrollRef}
              className="flex-1 overflow-y-auto px-4 py-3"
            >
              {exchanges.length === 0 ? (
                <div className="space-y-3">
                  <p className="text-sm text-slate-400">
                    Ask anything about the team currently loaded. The current roster, stats
                    window, pitcher, and recent games will be sent as context.
                  </p>
                  <div className="space-y-1.5">
                    <p className="text-xs uppercase tracking-wider text-slate-500">
                      Try one of these:
                    </p>
                    {PRESETS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => send(p)}
                        disabled={loading}
                        className="w-full rounded-md border border-slate-700 bg-slate-950/60 px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:border-emerald-500/40 hover:text-white disabled:opacity-50"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <ol className="space-y-4">
                  {exchanges.map((e) => (
                    <li key={e.id} className="space-y-2">
                      <div className="rounded-md bg-slate-800/60 px-3 py-2 text-sm text-slate-200">
                        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                          You
                        </p>
                        <p className="mt-1 whitespace-pre-wrap">{e.question}</p>
                      </div>
                      <div className="rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100">
                        <p className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                          AI{e.status === 'streaming' ? ' …' : ''}
                        </p>
                        {e.response ? (
                          <Markdown content={e.response} className="mt-1 text-sm leading-relaxed" />
                        ) : e.status === 'streaming' ? (
                          <p className="mt-1 text-slate-400">thinking…</p>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className="border-t border-slate-800 p-3">
              {limited && <div className="mb-2"><RateLimitBadge state={rateLimit} banner /></div>}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  send(question);
                }}
              >
                <div className="flex gap-2">
                  <textarea
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        send(question);
                      }
                    }}
                    rows={2}
                    placeholder={limited ? 'Rate limit reached — please wait for the cooldown' : 'Ask about the lineup, pitching, who to bench… (⌘/Ctrl + Enter)'}
                    className="min-h-[3rem] flex-1 resize-y rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none disabled:opacity-50"
                    disabled={loading || limited}
                  />
                  <button
                    type="submit"
                    disabled={loading || limited || !question.trim()}
                    className="self-end rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 hover:bg-emerald-500"
                  >
                    {loading ? '…' : 'Ask'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
