interface Props {
  values: number[];
  width?: number;
  height?: number;
}

export function Sparkline({ values, width = 80, height = 24 }: Props) {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 2;

  const points = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / range) * (height - pad * 2);
    return `${x},${y}`;
  });

  const first = values[0];
  const last = values[values.length - 1];
  const trending = last > first ? 'up' : last < first ? 'down' : 'flat';
  const trendColor =
    trending === 'up' ? '#34d399' : trending === 'down' ? '#f87171' : '#94a3b8';

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="inline-block"
      aria-label={`OVR trend: ${values[0]} → ${values[values.length - 1]}`}
    >
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={trendColor}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={points[points.length - 1].split(',')[0]}
        cy={points[points.length - 1].split(',')[1]}
        r={2}
        fill={trendColor}
      />
    </svg>
  );
}
