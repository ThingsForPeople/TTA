import { useCallback, useEffect, useRef, useState } from 'react';
import { ARCHETYPES, SIM_KEYS, SIM_LABELS, type PitchTalent, type SimStats } from '../lib/playerMeta';
import { STANDALONE_TALENTS } from '../lib/talentClassify';
import { TalentPicker } from './TalentPicker';
import { PitchTalentEditor } from './PitchTalentEditor';
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

// Display order for the recruit form — matches the in-game stat ordering shown
// on other pages (POW, CON, SPD, STA, FLD, ARM, PIT), distinct from the
// canonical SIM_KEYS order used for OVR math.
const RECRUIT_STAT_ORDER: (keyof SimStats)[] = ['pow', 'con', 'spd', 'sta', 'fld', 'arm', 'pit'];

function computeOvr(sim: SimStats): number {
  const total = SIM_KEYS.reduce((sum, k) => sum + sim[k], 0);
  return Math.round(total / SIM_KEYS.length);
}

function clamp(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(99, Math.round(n)));
}

const PROMPT_PREFIX =
  'I\'m evaluating a potential recruit as a LONG-TERM roster investment. ' +
  'Here are their stats:\n\n';
const PROMPT_SUFFIX =
  '\n\nEvaluate this recruit as a multi-season succession decision, NOT as an ' +
  'immediate upgrade check. Answer these specifically:\n' +
  '1. WORTH DEVELOPING? Is this player worth investing training into and leveling ' +
  'up over time? Judge by CEILING and runway, not current OVR — weigh their ' +
  'archetype-primary stats, age/seasons of useful service left (players start ~18 ' +
  'and retire around ~30, and retirement is becoming a real game mechanic), and ' +
  'latent talent unlocks. (When recruited, a player unlocks more talents from their ' +
  'own randomized unlock tiers — higher stat rolls/OVR tend to bring more and ' +
  'earlier unlocks — so the talents listed here, if any, undersell a strong recruit. ' +
  'Factor that hidden upside in.) Remember PIT is wasted OVR on a non-pitcher.\n' +
  '2. WHO DO THEY REPLACE, AND WHEN? Name the current starter(s) at their best ' +
  'position(s) that this recruit would compete with or eventually take over from, ' +
  'and give a rough timeline — would they push for the spot now, after a season or ' +
  'two of training, or only once the incumbent ages out/declines? Player ages show ' +
  'as "Age: N" on a roster line when I\'ve entered them (they\'re not in the game ' +
  'feed). Use the ages that are shown; if timing hinges on an incumbent whose age ' +
  'isn\'t shown, name them and ASK me instead of guessing.\n' +
  '3. LOCK-AND-HOLD PLAN. I can "lock" a recruit in the recruit tab and they will ' +
  'NOT age while locked. So a viable move is to grab a young high-ceiling prospect, ' +
  'lock them to freeze their age for some number of years, and unlock + train them ' +
  'later as a planned replacement when an incumbent retires or declines. Give a ' +
  'concrete recommendation: develop now, LOCK and hold for ~N years then promote ' +
  '(say who they\'d replace), or pass — with a one-line reason.\n\n' +
  '(Salary cap room is ample, so don\'t reject them just for adding payroll.)\n\n' +
  'Be concise — bullets, not paragraphs. Lead with the verdict.';

export function RecruitAnalyzer({ open, onClose, buildContext, buildCompactContext, teamUuid, inline }: Props) {
  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [archetype, setArchetype] = useState('');
  const [sim, setSim] = useState<SimStats>({ ...ZERO });
  const [talents, setTalents] = useState<string[]>([]);
  const [talentLevels, setTalentLevels] = useState<Record<string, number>>({});
  const [pitchTalents, setPitchTalents] = useState<PitchTalent[]>([]);
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
      `Archetype: ${archetype || '(not provided)'}`,
      age.trim() ? `Age: ${age.trim()}` : 'Age: (not provided)',
      `OVR: ${ovr}`,
      RECRUIT_STAT_ORDER.map((k) => `${SIM_LABELS[k]}=${sim[k]}`).join(' '),
    ];
    if (talents.length) {
      const talentStr = talents.map((t) => {
        const lvl = talentLevels[t] ?? 1;
        return lvl > 1 ? `${t} Lv${lvl}` : t;
      }).join(', ');
      lines.push(`Talents: ${talentStr}`);
    }
    if (pitchTalents.length) {
      const pitchStr = pitchTalents.map((pt) => {
        const subs = pt.sub.length
          ? ` [${pt.sub.map((s) => `${s.name} Lv${s.level}`).join(', ')}]`
          : '';
        return `${pt.pitch} Lv${pt.level}${subs}`;
      }).join('; ');
      lines.push(`Pitches: ${pitchStr}`);
    }
    return lines.join('\n');
  }, [name, age, archetype, ovr, sim, talents, talentLevels, pitchTalents]);

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
    setAge('');
    setArchetype('');
    setSim({ ...ZERO });
    setTalents([]);
    setTalentLevels({});
    setPitchTalents([]);
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

      <p className="mb-3 text-xs text-slate-500">
        Long-term fit: is this player worth developing, who would they replace and when, and is it
        worth locking them (locked recruits don’t age) to hold as a future replacement.
      </p>

      <div className="space-y-4">
        <div className="flex gap-2">
          <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Player name (optional)"
                className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
              />
          <select
                value={archetype}
                onChange={(e) => setArchetype(e.target.value)}
                title="Player archetype"
                className="w-32 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
              >
                <option value="">Archetype</option>
                {ARCHETYPES.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
          <input
                type="number"
                min={18}
                max={40}
                value={age}
                onChange={(e) => setAge(e.target.value)}
                placeholder="Age"
                title="Players start as young as ~18 and retire around ~30"
                className="w-20 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
              />
        </div>

              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
                  Sim stats
                </div>
                <div className="grid grid-cols-7 gap-1.5">
                  {RECRUIT_STAT_ORDER.map((k) => (
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
                availableTalents={STANDALONE_TALENTS}
                label="Talents (general)"
              />

              <PitchTalentEditor
                pitchTalents={pitchTalents}
                onChange={setPitchTalents}
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
