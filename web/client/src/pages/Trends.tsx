import { useState } from "preact/hooks";
import { useApi } from "../lib/hooks";
import { round } from "../lib/format";
import { InteractiveChart } from "../components/InteractiveChart";

interface TrendData {
  metric: string;
  period: string;
  data: Array<{ period: string; value: number; data_points: number }>;
}

const METRIC_GROUPS = {
  "Vitals": {
    resting_hr: "Resting Heart Rate",
    hrv: "HRV (Weekly Avg)",
    spo2: "SpO2",
    respiration: "Respiration",
    weight: "Weight",
  },
  "Activity": {
    steps: "Steps",
    floors: "Floors Climbed",
    calories: "Calories",
    active_minutes: "Active Minutes",
  },
  "Recovery": {
    sleep_hours: "Sleep Hours",
    body_battery: "Body Battery (High)",
    stress: "Stress Level",
    training_readiness: "Training Readiness",
  },
  "Performance": {
    endurance_score: "Endurance Score",
    hill_score: "Hill Score",
    race_5k: "5K Time (sec)",
    race_10k: "10K Time (sec)",
  },
};

const METRIC_COLORS: Record<string, string> = {
  resting_hr: "var(--color-hr)",
  stress: "var(--color-stress)",
  steps: "var(--color-steps)",
  sleep_hours: "var(--color-sleep)",
  body_battery: "var(--color-battery)",
  spo2: "var(--color-spo2)",
  training_readiness: "var(--color-training)",
  hrv: "var(--color-hrv)",
  weight: "var(--color-weight)",
  endurance_score: "var(--color-battery)",
  hill_score: "var(--color-stress)",
  floors: "var(--color-steps)",
  calories: "var(--color-stress)",
  active_minutes: "var(--accent)",
  respiration: "var(--color-spo2)",
  race_5k: "var(--color-steps)",
  race_10k: "var(--color-steps)",
};

function TrendChart({ data, color, label, unit, height = 140 }: { data: Array<{ period: string; value: number }>; color: string; label?: string; unit?: string; height?: number }) {
  if (!data.length) return null;

  const values = data.map((d) => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);

  const points = data.map((d, i) => ({
    x: i / (data.length - 1),
    value: d.value,
    label: d.period,
  }));

  return (
    <div>
      <InteractiveChart
        series={[{ points, color, label: label ?? "Value", unit: unit ?? "" }]}
        height={height}
      />
      <div style="display:flex;justify-content:space-between;font-size:0.65rem;color:var(--text-dim);margin-top:0.25rem">
        <span>{data[0]!.period}</span>
        <span>min: {round(min)} · avg: {round(values.reduce((a, b) => a + b, 0) / values.length)} · max: {round(max)}</span>
        <span>{data[data.length - 1]!.period}</span>
      </div>
    </div>
  );
}

export function Trends() {
  const [metric, setMetric] = useState("resting_hr");
  const [period, setPeriod] = useState("daily");
  const [compare, setCompare] = useState("");

  const { data, loading } = useApi<TrendData>(`/trends/${metric}`, { period });
  const { data: compareData } = useApi<TrendData | null>(
    compare ? `/trends/${compare}` : "/trends/metrics",
    compare ? { period } : undefined
  );

  const allMetrics = Object.entries(METRIC_GROUPS).flatMap(([_, metrics]) => Object.entries(metrics));
  const color = METRIC_COLORS[metric] ?? "var(--accent)";
  const compareColor = METRIC_COLORS[compare] ?? "var(--text-dim)";

  return (
    <div>
      <div class="page-header">
        <div class="eyebrow">The Long View</div>
        <h1>
          Over <em>time</em>
        </h1>
        <div class="dateline" style="margin-top:1rem">
          <select
            value={metric}
            onChange={(e) => setMetric((e.target as HTMLSelectElement).value)}
          >
            {Object.entries(METRIC_GROUPS).map(([group, metrics]) => (
              <optgroup key={group} label={group}>
                {Object.entries(metrics).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <select
            value={period}
            onChange={(e) => setPeriod((e.target as HTMLSelectElement).value)}
          >
            <option value="daily">Daily</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </select>
          <select
            value={compare}
            onChange={(e) => setCompare((e.target as HTMLSelectElement).value)}
          >
            <option value="">Compare with…</option>
            {allMetrics.filter(([k]) => k !== metric).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <div class="loading">Loading...</div>
      ) : data?.data?.length ? (
        <>
          <div class="chart-container">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
              <h3 style="margin:0">
                <span style={`color:${color}`}>{allMetrics.find(([k]) => k === metric)?.[1] ?? metric}</span>
                {compare && compareData && 'data' in compareData && (
                  <span style="color:var(--text-dim)"> vs </span>
                )}
                {compare && compareData && 'data' in compareData && (
                  <span style={`color:${compareColor}`}>{allMetrics.find(([k]) => k === compare)?.[1] ?? compare}</span>
                )}
              </h3>
              <span style="font-size:0.7rem;color:var(--text-dim)">
                {data.data.length} data points · bold line = 7-pt moving avg
              </span>
            </div>
            <TrendChart data={data.data.filter((d) => d.value != null)} color={color} label={allMetrics.find(([k]) => k === metric)?.[1]} />
            {compare && compareData && 'data' in compareData && compareData.data?.length > 0 && (
              <div style="margin-top:1rem">
                <TrendChart data={compareData.data.filter((d: { value: number }) => d.value != null)} color={compareColor} label={allMetrics.find(([k]) => k === compare)?.[1]} />
              </div>
            )}
          </div>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Value</th>
                  {period !== "daily" && <th>Data Points</th>}
                </tr>
              </thead>
              <tbody>
                {[...data.data].reverse().slice(0, 50).map((d) => (
                  <tr key={d.period}>
                    <td>{d.period}</td>
                    <td style={`font-weight:600;color:${color}`}>{round(d.value)}</td>
                    {period !== "daily" && <td>{d.data_points}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div class="loading">No data available for this metric</div>
      )}
    </div>
  );
}
