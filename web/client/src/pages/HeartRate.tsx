import { useState } from "preact/hooks";
import { useApi } from "../lib/hooks";
import { round, formatDate } from "../lib/format";
import { MetricCard } from "../components/MetricCard";
import { Sparkline } from "../components/Sparkline";
import { InteractiveChart } from "../components/InteractiveChart";
import { CopyButtons } from "../components/CopyButtons";

interface HrRow {
  calendar_date: string;
  resting_hr: number;
  min_hr: number;
  max_hr: number;
  avg_hr: number;
}

interface IntradayPoint { timestamp_gmt: number; value: number }

interface HrDetail {
  summary: HrRow;
  heart_rate: IntradayPoint[];
}

const ZONE_COLORS = ["#7b8fa1", "#5aa39b", "#7ea067", "#d4a757", "#d2554f"];
const ZONE_BOUNDARIES = [97, 116, 136, 155, 175, 194]; // from hr_zones table

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function getZone(hr: number): number {
  for (let i = ZONE_BOUNDARIES.length - 1; i >= 0; i--) {
    if (hr >= (ZONE_BOUNDARIES[i] ?? 0)) return Math.min(i, 4);
  }
  return 0;
}

function buildHrMarkdown(data: HrDetail & { date: string }): string {
  const lines: string[] = [];
  lines.push(`# Heart Rate — ${data.date}`);
  lines.push("");
  lines.push("## Summary");
  const s = data.summary;
  const stat = (label: string, value: string | number | null | undefined) => {
    if (value == null || value === "" || value === 0) return;
    lines.push(`- **${label}:** ${value}`);
  };
  if (s) {
    stat("Resting", s.resting_hr ? `${s.resting_hr} bpm` : null);
    stat("Min", s.min_hr ? `${s.min_hr} bpm` : null);
    stat("Max", s.max_hr ? `${s.max_hr} bpm` : null);
    stat("Avg", s.avg_hr ? `${round(s.avg_hr)} bpm` : null);
  }
  if (data.heart_rate?.length) {
    const vals = data.heart_rate.map((p) => p.value).filter((v) => v != null && isFinite(v));
    const intradayAvg = vals.reduce((a, b) => a + b, 0) / vals.length;
    stat("Intraday avg", `${round(intradayAvg)} bpm over ${vals.length} samples`);

    const zoneTimes = [0, 0, 0, 0, 0];
    for (const p of data.heart_rate) zoneTimes[getZone(p.value)]!++;
    const total = vals.length;
    lines.push("", "## HR Zone Distribution");
    lines.push(`| Zone | Range | Time |`);
    lines.push(`|------|-------|------|`);
    for (let i = 0; i < 5; i++) {
      if ((zoneTimes[i] ?? 0) === 0) continue;
      const range = `${ZONE_BOUNDARIES[i]}-${ZONE_BOUNDARIES[i + 1] || "max"}`;
      const pct = ((zoneTimes[i]! / total) * 100).toFixed(0);
      lines.push(`| Z${i + 1} | ${range} bpm | ${pct}% |`);
    }
  }
  return lines.join("\n");
}

function HrDayChart({ data, height = 120 }: { data: IntradayPoint[]; height?: number }) {
  if (!data.length) return null;

  const values = data.map((d) => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);

  const points = data.map((d, i) => ({
    x: i / (data.length - 1),
    value: d.value,
    label: `${formatTime(d.timestamp_gmt)} — Z${getZone(d.value) + 1}`,
  }));

  // Zone time distribution
  const zoneTimes = [0, 0, 0, 0, 0];
  for (const d of data) {
    zoneTimes[getZone(d.value)]!++;
  }
  const totalPts = data.length;

  return (
    <div>
      <div class="chart-container">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
          <h3 style="margin:0">24-Hour Heart Rate</h3>
          <span style="font-size:0.75rem;color:var(--text-dim)">
            avg: {avg} · min: {min} · max: {max} bpm
          </span>
        </div>

        <div style="display:flex;justify-content:space-between;margin-bottom:0.25rem">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => {
            const idx = Math.min(Math.floor(f * (data.length - 1)), data.length - 1);
            return (
              <span key={f} style="font-size:0.65rem;color:var(--text-dim)">
                {formatTime(data[idx]!.timestamp_gmt)}
              </span>
            );
          })}
        </div>

        <InteractiveChart
          series={[{ points, color: "var(--color-hr)", label: "HR", unit: " bpm" }]}
          height={height}
        />
      </div>

      {/* Zone distribution */}
      <div class="chart-container">
        <h3>Time in HR Zones</h3>
        <div style="display:flex;height:28px;overflow:hidden;gap:1px;margin-bottom:0.875rem;background:var(--ink-raised)">
          {zoneTimes.map((count, i) =>
            count > 0 ? (
              <div
                key={i}
                style={`width:${(count / totalPts) * 100}%;background:${ZONE_COLORS[i]};display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:0.6875rem;font-weight:500;color:var(--ink);letter-spacing:0.05em;min-width:22px`}
              >
                Z{i + 1}
              </div>
            ) : null
          )}
        </div>
        <div style="display:flex;gap:1.5rem;flex-wrap:wrap;font-size:0.8rem">
          {zoneTimes.map((count, i) => {
            const pct = ((count / totalPts) * 100).toFixed(0);
            return count > 0 ? (
              <span key={i} style={`color:${ZONE_COLORS[i]}`}>
                Z{i + 1} ({ZONE_BOUNDARIES[i]}-{ZONE_BOUNDARIES[i + 1] || "max"}): {pct}%
              </span>
            ) : null;
          })}
        </div>
      </div>
    </div>
  );
}

export function HeartRate() {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const { data, loading } = useApi<HrRow[]>("/health/heart-rate", { days: "30" });
  const { data: detail } = useApi<HrDetail | null>(
    selectedDate ? `/health/heart-rate/${selectedDate}` : "/health/heart-rate",
    selectedDate ? undefined : { days: "0" }
  );

  if (loading) return <div class="loading">Loading...</div>;
  if (!data?.length) return <div class="loading">No heart rate data</div>;

  const latest = data[data.length - 1]!;

  return (
    <div>
      <div class="page-header">
        <div class="eyebrow">The Engine</div>
        <h1>
          Heart <em>rate</em>
        </h1>
        <div class="dateline">
          <span>Last 30 days</span>
          <span class="sep">/</span>
          <span class="accent">Select a date for 24h detail</span>
        </div>
      </div>

      <div class="cards">
        <MetricCard label="Resting HR" value={latest.resting_hr ?? "--"} unit="bpm" color="var(--color-hr)">
          <Sparkline data={data.map((d) => d.resting_hr).filter(Boolean) as number[]} color="var(--color-hr)" />
        </MetricCard>

        <MetricCard label="Min HR" value={latest.min_hr ?? "--"} unit="bpm" color="#3b82f6">
          <Sparkline data={data.map((d) => d.min_hr).filter(Boolean) as number[]} color="#3b82f6" />
        </MetricCard>

        <MetricCard label="Max HR" value={latest.max_hr ?? "--"} unit="bpm" color="#ef4444">
          <Sparkline data={data.map((d) => d.max_hr).filter(Boolean) as number[]} color="#ef4444" />
        </MetricCard>

        <MetricCard label="Avg HR" value={latest.avg_hr != null ? round(latest.avg_hr) : "--"} unit="bpm" color="var(--color-stress)">
          <Sparkline data={data.map((d) => d.avg_hr).filter(Boolean) as number[]} color="var(--color-stress)" />
        </MetricCard>
      </div>

      {/* Date selector */}
      <div class="date-rail">
        {[...data].reverse().map((d) => (
          <button
            key={d.calendar_date}
            onClick={() => setSelectedDate(selectedDate === d.calendar_date ? null : d.calendar_date)}
            class={selectedDate === d.calendar_date ? "active" : ""}
          >
            {formatDate(d.calendar_date)}
          </button>
        ))}
      </div>

      {selectedDate && detail && 'heart_rate' in detail && detail.heart_rate?.length > 0 && (
        <>
          <CopyButtons data={{ ...detail, date: selectedDate }} buildMarkdown={buildHrMarkdown} />
          <HrDayChart data={detail.heart_rate} />
        </>
      )}

      <div class="table-wrap">
        <h3>Daily Summary</h3>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Resting</th>
              <th>Min</th>
              <th>Max</th>
              <th>Avg</th>
            </tr>
          </thead>
          <tbody>
            {[...data].reverse().map((d) => (
              <tr key={d.calendar_date}>
                <td>{formatDate(d.calendar_date)}</td>
                <td style="font-weight:600;color:var(--color-hr)">{d.resting_hr} bpm</td>
                <td>{d.min_hr} bpm</td>
                <td>{d.max_hr} bpm</td>
                <td>{d.avg_hr ? round(d.avg_hr) : "--"} bpm</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
