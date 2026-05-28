'use client';

import { useState, type ReactNode } from 'react';

interface Props {
  title: string;
  subtitle?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  headerAction?: ReactNode;
}

export function CollapsiblePanel({ title, subtitle, children, defaultOpen = true, headerAction }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="flex flex-1 items-center justify-between px-4 py-3 text-left"
        >
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
              {title}
            </h2>
            {subtitle && (
              <p className="mt-0.5 text-[11px] text-slate-500">{subtitle}</p>
            )}
          </div>
          <span className="ml-2 text-xs text-slate-500">{open ? '▾' : '▸'}</span>
        </button>
        {headerAction && (
          <div className="pr-4" onClick={(e) => e.stopPropagation()}>
            {headerAction}
          </div>
        )}
      </div>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
}
