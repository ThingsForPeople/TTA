import { useState } from 'react';

interface Props {
  raw: unknown;
}

export function RawJsonPanel({ raw }: Props) {
  const [open, setOpen] = useState(false);
  const text = JSON.stringify(raw, null, 2);

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left text-sm font-semibold uppercase tracking-wider text-slate-300 hover:text-slate-100"
      >
        <span>Raw API response</span>
        <span className="text-xs text-slate-500">{open ? 'hide' : 'show'}</span>
      </button>
      {open ? (
        <>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(text)}
              className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-800"
            >
              Copy
            </button>
          </div>
          <pre className="mt-2 max-h-96 overflow-auto rounded bg-slate-950 p-3 font-mono text-xs text-slate-300">
            {text}
          </pre>
        </>
      ) : null}
    </section>
  );
}
