import { useApi } from "../lib/hooks";
import { useQueryState } from "../lib/useQueryState";
import { round, formatDate } from "../lib/format";
import { MetricCard } from "../components/MetricCard";
import { Sparkline } from "../components/Sparkline";
import { InteractiveChart } from "../components/InteractiveChart";
import { CopyButtons } from "../components/CopyButtons";

interface StressRow {
  calendar_date: string;
  avg_stress: number;
  max_stress: number;
  stress_qualifier: string;
}

interface BatteryRow {
  calendar_date: string;
  charged: number;
  drained: number;
  highest: number;
  lowest: number;
  most_recent: number;
  at_wake: number;
}

interface IntradayPoint { timestamp_gmt: number; value: number }
interface BatteryPoint { timestamp_gmt: number; value: number; status: string }

interface DayDetail {
  summary: StressRow;
  daily: {
    low_stress_seconds: number;
    medium_stress_seconds: number;
    high_stress_seconds: number;
    body_battery_charged: number;
    body_battery_drained: number;
    body_battery_highest: number;
    body_battery_lowest: number;
    body_battery_at_wake: number;
    body_battery_most_recent: number;
  };
  stress: IntradayPoint[];
  body_battery: BatteryPoint[];
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function IntradayChart({
  data, color, label, unit, height = 80,
}: {
  data: IntradayPoint[];
  color: string;
  label: string;
  unit: string;
  height?: number;
}) {
  if (!data.length) return null;
  const values = data.map((d) => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);

  const points = data.map((d, i) => ({
    x: i / (data.length - 1),
    value: d.value,
    label: formatTime(d.timestamp_gmt),
  }));

  return (
    <div class="chart-container">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
        <h3 style="margin:0">{label}</h3>
        <span style="font-size:0.75rem;color:var(--text-dim)">
          avg: {avg}{unit} · min: {min}{unit} · max: {max}{unit}
        </span>
      </div>

      <div style="display:flex;justify-content:space-between;margin-bottom:0.25rem">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const idx = Math.min(Math.floor(f * (data.length - 1)), data.length - 1);
          return <span key={f} style="font-size:0.65rem;color:var(--text-dim)">{formatTime(data[idx]!.timestamp_gmt)}</span>;
        })}
      </div>

      <InteractiveChart
        series={[{ points, color, label, unit }]}
        height={height}
      />
    </div>
  );
}

function StressBreakdown({ low, med, high }: { low: number; med: number; high: number }) {
  const total = low + med + high;
  if (!total) return null;
  const fmt = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };
  const pct = (v: number) => ((v / total) * 100).toFixed(0);

  return (
    <div class="chart-container">
      <h3>Stress Breakdown</h3>
      <div style="display:flex;height:28px;overflow:hidden;gap:1px;margin-bottom:0.875rem;background:var(--ink-raised)">
        <div style={`width:${pct(low)}%;background:var(--moss);display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:0.6875rem;font-weight:500;color:var(--ink);letter-spacing:0.05em`}>
          {pct(low)}%
        </div>
        <div style={`width:${pct(med)}%;background:var(--ochre);display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:0.6875rem;font-weight:500;color:var(--ink);letter-spacing:0.05em`}>
          {pct(med)}%
        </div>
        <div style={`width:${pct(high)}%;background:var(--crimson);display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:0.6875rem;font-weight:500;color:var(--bone);letter-spacing:0.05em`}>
          {pct(high)}%
        </div>
      </div>
      <div style="display:flex;gap:2rem;font-family:var(--font-mono);font-size:0.75rem;letter-spacing:0.08em;text-transform:uppercase">
        <span style="color:var(--moss)">Low · {fmt(low)}</span>
        <span style="color:var(--ochre)">Medium · {fmt(med)}</span>
        <span style="color:var(--crimson)">High · {fmt(high)}</span>
      </div>
    </div>
  );
}

function fmtSeconds(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function buildStressMarkdown(data: DayDetail & { date: string }): string {
  const lines: string[] = [];
  lines.push(`# Stress & Body Battery — ${data.date}`);
  lines.push("");

  lines.push("## Stress");
  const stat = (label: string, value: string | number | null | undefined) => {
    if (value == null || value === "" || value === 0) return;
    lines.push(`- **${label}:** ${value}`);
  };
  if (data.summary) {
    stat("Average", data.summary.avg_stress);
    stat("Maximum", data.summary.max_stress);
    stat("Quality", data.summary.stress_qualifier);
  }
  if (data.daily) {
    const low = data.daily.low_stress_seconds || 0;
    const med = data.daily.medium_stress_seconds || 0;
    const high = data.daily.high_stress_seconds || 0;
    const total = low + med + high;
    if (total > 0) {
      const pct = (v: number) => `${((v / total) * 100).toFixed(0)}%`;
      lines.push("", "### Stress Breakdown");
      lines.push(`- **Low:** ${fmtSeconds(low)} (${pct(low)})`);
      lines.push(`- **Medium:** ${fmtSeconds(med)} (${pct(med)})`);
      lines.push(`- **High:** ${fmtSeconds(high)} (${pct(high)})`);
    }
  }

  if (data.daily) {
    lines.push("", "## Body Battery");
    stat("Highest", data.daily.body_battery_highest);
    stat("Lowest", data.daily.body_battery_lowest);
    stat("At wake", data.daily.body_battery_at_wake);
    stat("Most recent", data.daily.body_battery_most_recent);
    stat("Charged", data.daily.body_battery_charged ? `+${data.daily.body_battery_charged}` : null);
    stat("Drained", data.daily.body_battery_drained ? `-${data.daily.body_battery_drained}` : null);
  }

  return lines.join("\n");
}

function DayDrilldown({ date }: { date: string }) {
  const { data, loading } = useApi<DayDetail>(`/health/stress/${date}`);

  if (loading) return <div class="loading">Loading...</div>;
  if (!data) return <div class="loading">No data for this date</div>;

  return (
    <div>
      <CopyButtons data={{ ...data, date }} buildMarkdown={buildStressMarkdown} />
      {data.daily && (
        <StressBreakdown
          low={data.daily.low_stress_seconds || 0}
          med={data.daily.medium_stress_seconds || 0}
          high={data.daily.high_stress_seconds || 0}
        />
      )}

      <IntradayChart data={data.stress} color="var(--color-stress)" label="Stress Level (24h)" unit="" height={100} />

      <IntradayChart
        data={data.body_battery.map((b) => ({ timestamp_gmt: b.timestamp_gmt, value: b.value }))}
        color="var(--color-battery)"
        label="Body Battery (24h)"
        unit=""
        height={100}
      />
    </div>
  );
}

export function StressBodyBattery() {
  const [selectedDate, setSelectedDate] = useQueryState("date", "");
  const { data: stressData, loading: l1 } = useApi<StressRow[]>("/health/stress", { days: "30" });
  const { data: batteryData, loading: l2 } = useApi<BatteryRow[]>("/health/body-battery", { days: "30" });

  if (l1 || l2) return <div class="loading">Loading...</div>;

  const latestStress = stressData?.[stressData.length - 1];
  const latestBattery = batteryData?.[batteryData.length - 1];

  return (
    <div>
      <div class="page-header">
        <div class="eyebrow">Reservoirs</div>
        <h1>
          Stress &amp; <em>battery</em>
        </h1>
        <div class="dateline">
          <span>Last 30 days</span>
          <span class="sep">/</span>
          <span class="accent">Select a date for 24h detail</span>
        </div>
      </div>

      <div class="cards">
        <MetricCard label="Avg Stress" value={latestStress?.avg_stress ?? "--"} color="var(--color-stress)"
          sub={latestStress?.stress_qualifier ?? ""}>
          <Sparkline data={stressData?.map((d) => d.avg_stress).filter(Boolean) as number[] ?? []} color="var(--color-stress)" />
        </MetricCard>

        <MetricCard label="Max Stress" value={latestStress?.max_stress ?? "--"} color="var(--color-hr)">
          <Sparkline data={stressData?.map((d) => d.max_stress).filter(Boolean) as number[] ?? []} color="var(--color-hr)" />
        </MetricCard>

        <MetricCard label="Body Battery High" value={latestBattery?.highest ?? "--"} color="var(--color-battery)"
          sub={latestBattery ? `Wake: ${latestBattery.at_wake}` : ""}>
          <Sparkline data={batteryData?.map((d) => d.highest).filter(Boolean) as number[] ?? []} color="var(--color-battery)" />
        </MetricCard>

        <MetricCard label="Charge / Drain" value={latestBattery ? `+${latestBattery.charged}/-${latestBattery.drained}` : "--"}
          color="var(--color-battery)">
          <Sparkline data={batteryData?.map((d) => d.charged).filter(Boolean) as number[] ?? []} color="var(--color-battery)" />
        </MetricCard>
      </div>

      {/* Date selector */}
      {stressData && stressData.length > 0 && (
        <div class="date-rail">
          {[...stressData].reverse().map((d) => (
            <button
              key={d.calendar_date}
              onClick={() => setSelectedDate(selectedDate === d.calendar_date ? "" : d.calendar_date)}
              class={selectedDate === d.calendar_date ? "active" : ""}
            >
              {formatDate(d.calendar_date)}
            </button>
          ))}
        </div>
      )}

      {selectedDate && <DayDrilldown date={selectedDate} />}

      <div class="table-wrap">
        <h3>Daily Summary</h3>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Avg Stress</th>
              <th>Max Stress</th>
              <th>Quality</th>
              <th>BB High</th>
              <th>BB Low</th>
              <th>BB Wake</th>
              <th>Charged</th>
              <th>Drained</th>
            </tr>
          </thead>
          <tbody>
            {stressData && batteryData && [...stressData].reverse().map((s) => {
              const b = batteryData.find((bb) => bb.calendar_date === s.calendar_date);
              return (
                <tr key={s.calendar_date}>
                  <td>{formatDate(s.calendar_date)}</td>
                  <td>{s.avg_stress}</td>
                  <td>{s.max_stress}</td>
                  <td>
                    <span class={`badge ${s.stress_qualifier === "CALM" || s.stress_qualifier === "LOW" ? "badge-green"
                      : s.stress_qualifier === "MEDIUM" ? "badge-yellow" : "badge-red"}`}>
                      {s.stress_qualifier || "--"}
                    </span>
                  </td>
                  <td>{b?.highest ?? "--"}</td>
                  <td>{b?.lowest ?? "--"}</td>
                  <td>{b?.at_wake ?? "--"}</td>
                  <td style="color:#22c55e">{b?.charged ? `+${b.charged}` : "--"}</td>
                  <td style="color:#ef4444">{b?.drained ? `-${b.drained}` : "--"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
