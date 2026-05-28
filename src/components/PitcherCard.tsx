import { formatPitch } from '../lib/analysis';
import type { Player } from '../lib/types';

interface Props {
  pitcher: Player | undefined;
}

const PITCH_KEYS = ['era', 'whip', 'ip', 'k', 'bb'] as const;
const LABELS: Record<(typeof PITCH_KEYS)[number], string> = {
  era: 'ERA',
  whip: 'WHIP',
  ip: 'IP',
  k: 'K',
  bb: 'BB',
};

export function PitcherCard({ pitcher }: Props) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300">
        Pitcher stats
      </h2>
      {!pitcher ? (
        <p className="text-sm text-slate-400">No pitcher detected in response.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
                <th className="px-2 py-1.5 text-left font-medium">Player</th>
                <th className="px-2 py-1.5 text-left font-medium">Pos</th>
                {PITCH_KEYS.map((k) => (
                  <th key={k} className="px-2 py-1.5 text-right font-medium">{LABELS[k]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-slate-800/60">
                <td className="px-2 py-1.5 text-slate-100">{pitcher.name}</td>
                <td className="px-2 py-1.5 text-slate-400">{pitcher.position ?? 'P'}</td>
                {PITCH_KEYS.map((k) => (
                  <td key={k} className="px-2 py-1.5 text-right font-mono text-slate-200">
                    {formatPitch(k, pitcher.pitching?.[k])}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
