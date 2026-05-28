import {
  MODE_OPTIONS,
  TIME_OPTIONS,
  type ModeFilter,
  type TimeFilter,
} from '../lib/api';

interface Props {
  time: TimeFilter;
  mode: ModeFilter;
  onChange: (next: { time: TimeFilter; mode: ModeFilter }) => void;
  loading: boolean;
  inline?: boolean;
}

const SELECT_CLS =
  'rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none disabled:cursor-wait disabled:opacity-60';

export function TimeRangeFilter({ time, mode, onChange, loading, inline }: Props) {
  const filtered = time !== 'all' || mode !== 'all';

  const controls = (
    <>
      <label className="flex items-center gap-1.5 text-xs text-slate-400">
        Time
        <select
          value={time}
          disabled={loading}
          onChange={(e) => onChange({ time: e.target.value as TimeFilter, mode })}
          className={SELECT_CLS}
        >
          {TIME_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1.5 text-xs text-slate-400">
        Mode
        <select
          value={mode}
          disabled={loading}
          onChange={(e) => onChange({ time, mode: e.target.value as ModeFilter })}
          className={SELECT_CLS}
        >
          {MODE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      {filtered ? (
        <button
          type="button"
          onClick={() => onChange({ time: 'all', mode: 'all' })}
          disabled={loading}
          className="text-xs text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline disabled:opacity-60"
        >
          Reset
        </button>
      ) : null}

      {loading ? <span className="text-xs text-slate-500">Loading…</span> : null}
    </>
  );

  if (inline) {
    return <div className="flex flex-wrap items-center gap-3">{controls}</div>;
  }

  return (
    <section className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
        Roster stats filter
      </span>
      {controls}
    </section>
  );
}
