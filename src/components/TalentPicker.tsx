import { useEffect, useRef, useState } from 'react';
import { ALL_TALENTS, CATEGORY_COLORS, type TalentDef } from '../lib/talents';
import { MAX_TALENT_LEVEL } from '../lib/playerMeta';
import { useDropdownPosition } from '../hooks/useDropdownPosition';

interface Props {
  selected: string[];
  levels?: Record<string, number>;
  onChange: (talents: string[]) => void;
  onLevelChange?: (talent: string, level: number) => void;
  availableTalents?: TalentDef[];
  label?: string;
}

export function TalentPicker({ selected, levels, onChange, onLevelChange, availableTalents, label }: Props) {
  const talentPool = availableTalents ?? ALL_TALENTS;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropPos = useDropdownPosition(inputRef, open, 256);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedSet = new Set(selected);
  const lower = query.toLowerCase();
  const filtered = query
    ? talentPool.filter(
        (t) => !selectedSet.has(t.name) && t.name.toLowerCase().includes(lower),
      )
    : talentPool.filter((t) => !selectedSet.has(t.name));

  useEffect(() => {
    setHighlightIdx(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const item = listRef.current.children[highlightIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [highlightIdx, open]);

  const add = (name: string) => {
    onChange([...selected, name]);
    setQuery('');
    setOpen(false);
  };

  const remove = (name: string) => {
    onChange(selected.filter((t) => t !== name));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[highlightIdx]) add(filtered[highlightIdx].name);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="mt-2">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">{label ?? 'Talents'}</div>
      <div className="flex flex-wrap items-center gap-1">
        {selected.length === 0 ? (
          <span className="text-xs text-slate-500">none</span>
        ) : (
          selected.map((t) => {
            const def = ALL_TALENTS.find((d) => d.name === t);
            const catColor = def ? CATEGORY_COLORS[def.category] : 'text-slate-200';
            const lvl = levels?.[t] ?? 1;
            return (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded bg-slate-800 px-2 py-0.5 text-xs"
              >
                <span className={catColor}>{t}</span>
                <span className="inline-flex gap-px rounded bg-slate-900 px-0.5">
                  {Array.from({ length: MAX_TALENT_LEVEL }, (_, i) => i + 1).map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => onLevelChange?.(t, n)}
                      className={
                        'px-1 py-0.5 text-[10px] font-mono rounded ' +
                        (n === lvl
                          ? 'bg-emerald-500/25 text-emerald-300'
                          : 'text-slate-500 hover:text-slate-300')
                      }
                      aria-label={`Set ${t} to level ${n}`}
                    >
                      {n}
                    </button>
                  ))}
                </span>
                <button
                  type="button"
                  onClick={() => remove(t)}
                  className="text-slate-500 hover:text-red-300"
                  aria-label={`Remove ${t}`}
                >
                  ×
                </button>
              </span>
            );
          })
        )}
      </div>

      <div ref={containerRef} className="relative mt-1">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="type to search talents…"
          className="w-48 max-w-full rounded border border-slate-700 bg-slate-950 px-2 py-0.5 text-xs text-slate-100 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
        />

        {open && filtered.length > 0 && dropPos ? (
          <ul
            ref={listRef}
            className="fixed z-[100] max-h-48 overflow-y-auto rounded border border-slate-700 bg-slate-900 shadow-lg"
            style={{ top: dropPos.top, left: dropPos.left, width: dropPos.width }}
          >
            {filtered.slice(0, 30).map((t, i) => (
              <DropdownItem
                key={t.name}
                talent={t}
                highlighted={i === highlightIdx}
                onSelect={() => add(t.name)}
                onHover={() => setHighlightIdx(i)}
              />
            ))}
            {filtered.length > 30 ? (
              <li className="px-2 py-1 text-[10px] text-slate-500">
                {filtered.length - 30} more — keep typing to narrow
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function DropdownItem({
  talent,
  highlighted,
  onSelect,
  onHover,
}: {
  talent: TalentDef;
  highlighted: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  return (
    <li
      role="option"
      aria-selected={highlighted}
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect();
      }}
      onMouseEnter={onHover}
      className={
        'cursor-pointer px-2 py-1.5 ' +
        (highlighted ? 'bg-emerald-500/15' : 'hover:bg-slate-800')
      }
    >
      <div className="flex items-center justify-between">
        <span className={'text-xs ' + (highlighted ? 'text-slate-100' : 'text-slate-300')}>
          {talent.name}
        </span>
        <span className={'text-[10px] ' + CATEGORY_COLORS[talent.category]}>
          {talent.category}
        </span>
      </div>
      <p className="mt-0.5 text-[10px] leading-tight text-slate-500">{talent.description}</p>
    </li>
  );
}
