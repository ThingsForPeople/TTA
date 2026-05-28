import { useCallback, useEffect, useRef, useState } from 'react';
import { SIM_KEYS, SIM_LABELS, type SimStats } from '../lib/playerMeta';
import { TalentPicker } from './TalentPicker';
import { Markdown } from './Markdown';
import { RateLimitBadge } from './RateLimitBadge';
import { readRateLimitBody, readRateLimitHeaders, useRateLimit } from '../hooks/useRateLimit';

interface Props {
  open: boolean;
  onClose: () => void;
  buildContext: () => string;
  buildCompactContext: () => string;
  teamUuid?: string;
  inline?: boolean;
}

const ZERO: SimStats = { con: 0, pow: 0, spd: 0, fld: 0, arm: 0, pit: 0, sta: 0 };

function computeOvr(sim: SimStats): number {
  const total = SIM_KEYS.reduce((sum, k) => sum + sim[k], 0);
  return Math.round(total / SIM_KEYS.length);
}

function clamp(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(99, Math.round(n)));
}

const PROMPT_PREFIX =
  'I\'m evaluating a potential recruit for my roster. Here are their stats:\n\n';
const PROMPT_SUFFIX =
  '\n\nShould I pick up this player? Consider: where they\'d fit positionally, ' +
  'whether they improve on anyone currently in the lineup, what their OVR means ' +
  'given that PIT is wasted on non-pitchers, and whether they\'re worth the ' +
  'training/injury maintenance cost. Be concise — bullets, not paragraphs.';

export function RecruitAnalyzer({ open, onClose, buildContext, buildCompactContext, teamUuid, inline }: Props) {
  const [name, setName] = useState('');
  const [sim, setSim] = useState<SimStats>({ ...ZERO });
  const [talents, setTalents] = useState<string[]>([]);
  const [talentLevels, setTalentLevels] = useState<Record<string, number>>({});
  const [feedback, setFeedback] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'streaming' | 'done' | 'error'>('idle');
  const abortRef = useRef<AbortController | null>(null);
  const [rateLimit, updateRateLimit] = useRateLimit();

  const ovr = computeOvr(sim);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open && abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, [open]);

  const buildRecruitBlock = useCallback(() => {
    const lines = [
      name ? `**${name}**` : '(unnamed recruit)',
      `OVR: ${ovr}`,
      SIM_KEYS.map((k) => `${SIM_LABELS[k]}=${sim[k]}`).join(' '),
    ];
    if (talents.length) {
      const talentStr = talents.map((t) => {
        const lvl = talentLevels[t] ?? 1;
        return lvl > 1 ? `${t} Lv${lvl}` : t;
      }).join(', ');
      lines.push(`Talents: ${talentStr}`);
    }
    return lines.join('\n');
  }, [name, ovr, sim, talents, talentLevels]);

  const analyze = useCallback(async () => {
    abortRef.current?.abort();
    setFeedback('');
    setStatus('streaming');

    const controller = new AbortController();
    abortRef.current = controller;

    const question = PROMPT_PREFIX + buildRecruitBlock() + PROMPT_SUFFIX;

    try {
      const res = await fetch('/api/advise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: buildContext(),
          compactContext: buildCompactContext(),
          question,
          history: [],
          teamUuid,
          actionType: 'recruit',
        }),
        signal: controller.signal,
      });

      if (res.status === 429) {
        const body = await res.json();
        const info = readRateLimitBody(body);
        if (info) updateRateLimit(info);
        setFeedback(null);
        setStatus('idle');
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
        setFeedback(buf);
      }
      setStatus('done');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback((prev) => (prev || '') + `\n\n[error: ${msg}]`);
      setStatus('error');
    } finally {
      abortRef.current = null;
    }
  }, [buildContext, buildRecruitBlock, updateRateLimit]);

  const reset = () => {
    setName('');
    setSim({ ...ZERO });
    setTalents([]);
    setTalentLevels({});
    setFeedback(null);
    setStatus('idle');
  };

  const hasStats = SIM_KEYS.some((k) => sim[k] > 0);

  if (!open) return null;

  const content = (
    <>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
            Recruit Analyzer
          </h2>
          <RateLimitBadge state={rateLimit} />
          <span
            className={
              'rounded px-2 py-0.5 font-mono text-sm font-bold ' +
              (ovr >= 50
                ? 'bg-emerald-500/15 text-emerald-300'
                : ovr >= 30
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-slate-800 text-slate-400')
            }
          >
            OVR {ovr}
          </span>
        </div>
        <button
          type="button"
          onClick={reset}
          className="rounded-md px-2 py-0.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200"
        >
          clear
        </button>
      </div>

      <div className="space-y-4">
        <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Player name (optional)"
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
              />

              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
                  Sim stats
                </div>
                <div className="grid grid-cols-7 gap-1.5">
                  {SIM_KEYS.map((k) => (
                    <label key={k} className="flex flex-col text-center">
                      <span className="text-[10px] uppercase tracking-wider text-slate-500">
                        {SIM_LABELS[k]}
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={99}
                        value={sim[k]}
                        onChange={(e) =>
                          setSim((prev) => ({ ...prev, [k]: clamp(Number(e.target.value)) }))
                        }
                        className="mt-0.5 rounded border border-slate-700 bg-slate-950 px-1 py-1 text-center font-mono text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
                      />
                    </label>
                  ))}
                </div>
              </div>

              <TalentPicker
                selected={talents}
                levels={talentLevels}
                onChange={setTalents}
                onLevelChange={(t, lvl) =>
                  setTalentLevels((prev) => ({ ...prev, [t]: lvl }))
                }
              />

              <button
                type="button"
                onClick={analyze}
                disabled={!hasStats || status === 'streaming' || (rateLimit.remaining === 0 && !!rateLimit.countdown)}
                className={
                  'w-full rounded-md px-3 py-2 text-sm font-medium transition-colors ' +
                  (!hasStats || status === 'streaming' || (rateLimit.remaining === 0 && !!rateLimit.countdown)
                    ? 'cursor-not-allowed bg-slate-800 text-slate-500'
                    : 'bg-emerald-600 text-white hover:bg-emerald-500')
                }
              >
                {status === 'streaming'
                  ? 'analyzing…'
                  : feedback !== null
                    ? 're-analyze'
                    : 'analyze recruit'}
              </button>

        {feedback !== null ? (
          <div className="rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
            <Markdown
              content={feedback || (status === 'streaming' ? 'thinking…' : '')}
              className="text-sm leading-relaxed text-slate-200"
            />
          </div>
        ) : null}
      </div>
    </>
  );

  if (inline) {
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
        {content}
      </section>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-xl flex-col rounded-lg border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex-1 overflow-y-auto p-4">
          {content}
        </div>
      </div>
    </div>
  );
}
