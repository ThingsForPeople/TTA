import { useEffect, useRef, useState } from 'react';
import { CATEGORY_COLORS, type TalentDef } from '../lib/talents';
import { useDropdownPosition } from '../hooks/useDropdownPosition';
import { PITCH_SUB_TALENTS, PITCH_TYPE_TALENTS } from '../lib/talentClassify';
import { MAX_TALENT_LEVEL, type PitchTalent } from '../lib/playerMeta';

interface Props {
  pitchTalents: PitchTalent[];
  onChange: (next: PitchTalent[]) => void;
}

function LevelButtons({
  level,
  onChange,
}: {
  level: number;
  onChange: (n: number) => void;
}) {
  return (
    <span className="inline-flex gap-px rounded bg-slate-900 px-0.5">
      {Array.from({ length: MAX_TALENT_LEVEL }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          className={
            'px-1 py-0.5 text-[10px] font-mono rounded ' +
            (n === level
              ? 'bg-emerald-500/25 text-emerald-300'
              : 'text-slate-500 hover:text-slate-300')
          }
        >
          {n}
        </button>
      ))}
    </span>
  );
}

function SubTalentDropdown({
  exclude,
  onSelect,
}: {
  exclude: Set<string>;
  onSelect: (name: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropPos = useDropdownPosition(inputRef, open, 256);

  const lower = query.toLowerCase();
  const filtered = PITCH_SUB_TALENTS.filter(
    (t) => !exclude.has(t.name) && (!query || t.name.toLowerCase().includes(lower)),
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlightIdx(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlightIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (filtered[highlightIdx]) {
              onSelect(filtered[highlightIdx].name);
              setQuery('');
              setOpen(false);
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        placeholder="add zone/aim talent..."
        className="w-44 max-w-full rounded border border-slate-700 bg-slate-950 px-2 py-0.5 text-xs text-slate-100 placeholder:text-slate-600 focus:border-amber-500 focus:outline-none"
      />
      {open && filtered.length > 0 && dropPos && (
        <ul
          className="fixed z-[100] max-h-40 overflow-y-auto rounded border border-slate-700 bg-slate-900 shadow-lg"
          style={{ top: dropPos.top, left: dropPos.left, width: dropPos.width }}
        >
          {filtered.slice(0, 20).map((t, i) => (
            <li
              key={t.name}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(t.name);
                setQuery('');
                setOpen(false);
              }}
              onMouseEnter={() => setHighlightIdx(i)}
              className={
                'cursor-pointer px-2 py-1.5 ' +
                (i === highlightIdx ? 'bg-amber-500/15' : 'hover:bg-slate-800')
              }
            >
              <span className="text-xs text-slate-200">{t.name}</span>
              <p className="text-[10px] text-slate-500">{t.description}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PitchTypeDropdown({
  exclude,
  onSelect,
}: {
  exclude: Set<string>;
  onSelect: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropPos = useDropdownPosition(btnRef, open, 224);

  const available = PITCH_TYPE_TALENTS.filter((t) => !exclude.has(t.name));

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (available.length === 0) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded border border-dashed border-amber-500/40 px-2 py-1 text-xs text-amber-300/80 hover:bg-amber-500/10"
      >
        + add pitch
      </button>
      {open && dropPos && (
        <ul
          className="fixed z-[100] max-h-48 overflow-y-auto rounded border border-slate-700 bg-slate-900 shadow-lg"
          style={{ top: dropPos.top, left: dropPos.left, width: dropPos.width }}
        >
          {available.map((t) => (
            <li
              key={t.name}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(t.name);
                setOpen(false);
              }}
              className="cursor-pointer px-2 py-1.5 hover:bg-slate-800"
            >
              <span className="text-xs text-amber-300">{t.name}</span>
              <p className="text-[10px] text-slate-500">{t.description}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PitchTalentEditor({ pitchTalents, onChange }: Props) {
  const existingPitches = new Set(pitchTalents.map((p) => p.pitch));

  const addPitch = (name: string) => {
    onChange([...pitchTalents, { pitch: name, level: 1, sub: [] }]);
  };

  const removePitch = (idx: number) => {
    onChange(pitchTalents.filter((_, i) => i !== idx));
  };

  const setPitchLevel = (idx: number, level: number) => {
    const next = [...pitchTalents];
    next[idx] = { ...next[idx], level };
    onChange(next);
  };

  const addSub = (pitchIdx: number, name: string) => {
    const next = [...pitchTalents];
    next[pitchIdx] = {
      ...next[pitchIdx],
      sub: [...next[pitchIdx].sub, { name, level: 1 }],
    };
    onChange(next);
  };

  const removeSub = (pitchIdx: number, subIdx: number) => {
    const next = [...pitchTalents];
    next[pitchIdx] = {
      ...next[pitchIdx],
      sub: next[pitchIdx].sub.filter((_, i) => i !== subIdx),
    };
    onChange(next);
  };

  const setSubLevel = (pitchIdx: number, subIdx: number, level: number) => {
    const next = [...pitchTalents];
    const subs = [...next[pitchIdx].sub];
    subs[subIdx] = { ...subs[subIdx], level };
    next[pitchIdx] = { ...next[pitchIdx], sub: subs };
    onChange(next);
  };

  return (
    <div className="mt-2">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
        Pitch Repertoire
      </div>

      {pitchTalents.length === 0 && (
        <p className="mb-2 text-xs text-slate-500">No pitches added yet.</p>
      )}

      <div className="space-y-2">
        {pitchTalents.map((pt, pitchIdx) => {
          const existingSubs = new Set(pt.sub.map((s) => s.name));
          return (
            <div
              key={pt.pitch}
              className="rounded border border-amber-500/20 bg-slate-900/60 px-2.5 py-2"
            >
              {/* Pitch type header */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-amber-300">{pt.pitch}</span>
                <LevelButtons
                  level={pt.level}
                  onChange={(lvl) => setPitchLevel(pitchIdx, lvl)}
                />
                <button
                  type="button"
                  onClick={() => removePitch(pitchIdx)}
                  className="ml-auto text-xs text-slate-500 hover:text-red-300"
                >
                  ×
                </button>
              </div>

              {/* Sub-talents */}
              {pt.sub.length > 0 && (
                <div className="mt-1.5 ml-3 space-y-1">
                  {pt.sub.map((s, subIdx) => (
                    <div key={s.name} className="flex items-center gap-2">
                      <span className="text-[11px] text-slate-300">{s.name}</span>
                      <LevelButtons
                        level={s.level}
                        onChange={(lvl) => setSubLevel(pitchIdx, subIdx, lvl)}
                      />
                      <button
                        type="button"
                        onClick={() => removeSub(pitchIdx, subIdx)}
                        className="text-xs text-slate-500 hover:text-red-300"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add sub-talent */}
              <div className="mt-1.5 ml-3">
                <SubTalentDropdown
                  exclude={existingSubs}
                  onSelect={(name) => addSub(pitchIdx, name)}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-2">
        <PitchTypeDropdown exclude={existingPitches} onSelect={addPitch} />
      </div>
    </div>
  );
}
