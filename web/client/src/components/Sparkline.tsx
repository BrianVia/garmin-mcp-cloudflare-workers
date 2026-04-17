import { useId } from "preact/hooks";

interface Props {
  data: number[];
  color?: string;
  height?: number;
}

export function Sparkline({ data, color = "var(--rust)", height = 38 }: Props) {
  const gradId = `spark-${useId()}`;
  if (!data.length) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 100;
  const pad = 2;

  const points = data.map((v, i) => {
    const x = (i / Math.max(data.length - 1, 1)) * w;
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return [x, y];
  });

  const linePath = points.map(([x, y]) => `${x},${y}`).join(" ");
  const firstX = points[0]?.[0] ?? 0;
  const lastX = points[points.length - 1]?.[0] ?? 0;
  const fillPath = [
    `${firstX},${height}`,
    ...points.map(([x, y]) => `${x},${y}`),
    `${lastX},${height}`,
  ].join(" ");

  const last = points[points.length - 1];

  return (
    <div class="sparkline">
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color={color} stop-opacity="0.28" />
            <stop offset="100%" stop-color={color} stop-opacity="0" />
          </linearGradient>
        </defs>
        <polygon points={fillPath} fill={`url(#${gradId})`} />
        <polyline
          points={linePath}
          fill="none"
          stroke={color}
          stroke-width="1.25"
          stroke-linecap="round"
          stroke-linejoin="round"
          vector-effect="non-scaling-stroke"
        />
        {last && (
          <circle cx={last[0]} cy={last[1]} r="1.5" fill={color} vector-effect="non-scaling-stroke" />
        )}
      </svg>
    </div>
  );
}
