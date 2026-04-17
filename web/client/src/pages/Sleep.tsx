import { useState } from "preact/hooks";
import { useApi } from "../lib/hooks";
import { round, formatDate, formatMinutes } from "../lib/format";
import { MetricCard } from "../components/MetricCard";
import { SleepBar } from "../components/SleepBar";
import { Sparkline } from "../components/Sparkline";
import { SleepTimeline } from "../components/SleepTimeline";
import { SleepConsistency } from "../components/SleepConsistency";
import { CopyButtons } from "../components/CopyButtons";

interface SleepRow {
  calendar_date: string;
  sleep_hours: number;
  deep_min: number;
  light_min: number;
  rem_min: number;
  awake_min: number;
  average_hr_sleep: number;
  average_spo2: number;
  avg_sleep_stress: number;
  sleep_score_feedback: string;
  sleep_score_insight: string;
}

interface SleepTimeRow {
  calendar_date: string;
  sleep_start_local: number;
  sleep_end_local: number;
  sleep_score_feedback: string;
  sleep_score_insight: string;
  personalized_insight: string;
}

interface SleepDetail {
  summary: SleepRow;
  times: {
    sleep_start_local: number;
    sleep_end_local: number;
    sleep_start_gmt: number;
    sleep_end_gmt: number;
  };
  levels: Array<{ start_gmt: string; end_gmt: string; activity_level: number }>;
  heart_rate: Array<{ timestamp_gmt: number; value: number }>;
  hrv: Array<{ timestamp_gmt: number; value: number }>;
  stress: Array<{ timestamp_gmt: number; value: number }>;
  body_battery: Array<{ timestamp_gmt: number; value: number }>;
  respiration: Array<{ timestamp_gmt: number; value: number }>;
}

const FEEDBACK_LABELS: Record<string, { text: string; cls: string }> = {
  POSITIVE_LONG_AND_DEEP: { text: "Great sleep", cls: "badge-green" },
  POSITIVE_SHORT_BUT_DEEP: { text: "Short but deep", cls: "badge-green" },
  POSITIVE_RESTFUL_EVENING: { text: "Restful evening", cls: "badge-green" },
  NEGATIVE_LONG_BUT_DISCONTINUOUS: { text: "Restless", cls: "badge-yellow" },
  NEGATIVE_DISCONTINUOUS: { text: "Disrupted", cls: "badge-yellow" },
  NEGATIVE_SHORT_AND_DISCONTINUOUS: { text: "Short & restless", cls: "badge-red" },
  NEGATIVE_SHORT: { text: "Too short", cls: "badge-red" },
  NEGATIVE_LONG_BUT_SHALLOW: { text: "Shallow", cls: "badge-yellow" },
  NEGATIVE_SHORT_AND_SHALLOW: { text: "Short & shallow", cls: "badge-red" },
};

const INSIGHT_LABELS: Record<string, { text: string; cls: string }> = {
  POSITIVE_RESTFUL_EVENING: { text: "Restful evening", cls: "badge-green" },
  POSITIVE_LOW_STRESS: { text: "Low stress", cls: "badge-green" },
  NEGATIVE_HIGH_STRESS: { text: "High stress", cls: "badge-red" },
  NEGATIVE_LATE_ACTIVITY: { text: "Late activity", cls: "badge-yellow" },
};

function FeedbackBadge({ feedback, insight }: { feedback: string; insight: string }) {
  const fb = FEEDBACK_LABELS[feedback];
  const ins = insight !== "NONE" ? INSIGHT_LABELS[insight] : null;
  return (
    <div style="display:flex;gap:0.375rem;flex-wrap:wrap">
      {fb && <span class={`badge ${fb.cls}`}>{fb.text}</span>}
      {ins && <span class={`badge ${ins.cls}`}>{ins.text}</span>}
    </div>
  );
}

function seriesStats(points: Array<{ value: number }>) {
  if (!points.length) return null;
  const values = points.map((p) => p.value).filter((v) => v != null && isFinite(v));
  if (!values.length) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    avg: sum / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    count: values.length,
  };
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function buildSleepMarkdown(data: SleepDetail & { date: string }): string {
  const s = data.summary;
  const lines: string[] = [];

  lines.push(`# Sleep — ${data.date}`);
  if (data.times) {
    lines.push(`*${fmtTime(data.times.sleep_start_local)} → ${fmtTime(data.times.sleep_end_local)}*`);
  }
  lines.push("");

  lines.push("## Summary");
  const stat = (label: string, value: string | number | null | undefined) => {
    if (value == null || value === "" || value === 0) return;
    lines.push(`- **${label}:** ${value}`);
  };
  stat("Total", s?.sleep_hours ? `${round(s.sleep_hours)} hrs` : null);
  stat("Deep", s?.deep_min ? formatMinutes(s.deep_min) : null);
  stat("Light", s?.light_min ? formatMinutes(s.light_min) : null);
  stat("REM", s?.rem_min ? formatMinutes(s.rem_min) : null);
  stat("Awake", s?.awake_min ? formatMinutes(s.awake_min) : null);
  stat("Avg HR", s?.average_hr_sleep ? `${Math.round(s.average_hr_sleep)} bpm` : null);
  stat("Avg SpO2", s?.average_spo2 ? `${round(s.average_spo2)}%` : null);
  stat("Sleep stress", s?.avg_sleep_stress ? round(s.avg_sleep_stress) : null);
  stat("Quality", s?.sleep_score_feedback);
  stat("Insight", s?.sleep_score_insight && s.sleep_score_insight !== "NONE" ? s.sleep_score_insight : null);

  const addSeries = (label: string, series: Array<{ value: number }>, unit = "") => {
    const st = seriesStats(series);
    if (!st) return;
    lines.push(`- **${label}:** avg ${round(st.avg)}${unit} · min ${round(st.min)}${unit} · max ${round(st.max)}${unit}`);
  };
  if (data.heart_rate.length) {
    lines.push("", "## Overnight Series");
    addSeries("HR", data.heart_rate, " bpm");
    addSeries("HRV", data.hrv, " ms");
    addSeries("Stress", data.stress);
    addSeries("Body Battery", data.body_battery);
    addSeries("Respiration", data.respiration, " rpm");
  }

  return lines.join("\n");
}

function NightDetail({ date }: { date: string }) {
  const { data, loading } = useApi<SleepDetail>(`/health/sleep/${date}`);

  if (loading) return <div class="loading" style="padding:1.5rem">Loading night detail...</div>;
  if (!data || !data.levels?.length) return <div class="loading" style="padding:1.5rem">No detailed data available</div>;

  return (
    <div style="padding:1rem 1.25rem 1.25rem;border-top:1px solid var(--border)">
      <CopyButtons data={{ ...data, date }} buildMarkdown={buildSleepMarkdown} />
      <SleepTimeline
        levels={data.levels}
        heartRate={data.heart_rate}
        hrv={data.hrv}
        stress={data.stress}
        bodyBattery={data.body_battery}
        respiration={data.respiration}
        sleepStart={data.times.sleep_start_gmt}
        sleepEnd={data.times.sleep_end_gmt}
      />
    </div>
  );
}

export function Sleep() {
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const { data, loading } = useApi<SleepRow[]>("/health/sleep", { days: "30" });
  const { data: consistency } = useApi<SleepTimeRow[]>("/health/sleep/consistency", { days: "30" });

  if (loading) return <div class="loading">Loading...</div>;
  if (!data?.length) return <div class="loading">No sleep data available</div>;

  const latest = data[data.length - 1]!;
  const avgHours = data.reduce((s, d) => s + (d.sleep_hours || 0), 0) / data.length;
  const avgDeep = data.reduce((s, d) => s + (d.deep_min || 0), 0) / data.length;
  const avgRem = data.reduce((s, d) => s + (d.rem_min || 0), 0) / data.length;

  return (
    <div>
      <div class="page-header">
        <div class="eyebrow">Nocturnal Record</div>
        <h1>
          Hours <em>asleep</em>
        </h1>
        <div class="dateline">
          <span>Last 30 days</span>
          <span class="sep">/</span>
          <span class="accent">Click a row for night detail</span>
        </div>
      </div>

      <div class="cards">
        <MetricCard
          label="Last Night"
          value={round(latest.sleep_hours)}
          unit="hrs"
          color="var(--color-sleep)"
        >
          <SleepBar deep={latest.deep_min} light={latest.light_min} rem={latest.rem_min} awake={latest.awake_min} />
        </MetricCard>

        <MetricCard label="30-Day Avg" value={round(avgHours)} unit="hrs" color="var(--color-sleep)">
          <Sparkline data={data.map((d) => d.sleep_hours).filter(Boolean) as number[]} color="var(--color-sleep)" />
        </MetricCard>

        <MetricCard label="Sleep HR" value={round(latest.average_hr_sleep)} unit="bpm" color="var(--color-hr)">
          <Sparkline data={data.map((d) => d.average_hr_sleep).filter(Boolean) as number[]} color="var(--color-hr)" />
        </MetricCard>

        <MetricCard label="Avg Deep" value={formatMinutes(avgDeep)} color="var(--color-deep)">
          <Sparkline data={data.map((d) => d.deep_min).filter(Boolean) as number[]} color="var(--color-deep)" />
        </MetricCard>

        <MetricCard label="Avg REM" value={formatMinutes(avgRem)} color="var(--color-rem)">
          <Sparkline data={data.map((d) => d.rem_min).filter(Boolean) as number[]} color="var(--color-rem)" />
        </MetricCard>

        <MetricCard label="Sleep Stress" value={round(latest.avg_sleep_stress)} color="var(--color-stress)">
          <Sparkline data={data.map((d) => d.avg_sleep_stress).filter(Boolean) as number[]} color="var(--color-stress)" />
        </MetricCard>
      </div>

      {/* Sleep consistency chart */}
      {consistency && consistency.length > 0 && (
        <SleepConsistency data={consistency} />
      )}

      {/* Sleep history table */}
      <div class="table-wrap">
        <h3>Sleep History</h3>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Total</th>
              <th>Deep</th>
              <th>Light</th>
              <th>REM</th>
              <th>Awake</th>
              <th>Stages</th>
              <th>HR</th>
              <th>Quality</th>
            </tr>
          </thead>
          <tbody>
            {[...data].reverse().map((d) => (
              <>
                <tr
                  key={d.calendar_date}
                  onClick={() =>
                    setExpandedDate(expandedDate === d.calendar_date ? null : d.calendar_date)
                  }
                  style="cursor:pointer"
                >
                  <td>{formatDate(d.calendar_date)}</td>
                  <td>{round(d.sleep_hours)}h</td>
                  <td>{formatMinutes(d.deep_min)}</td>
                  <td>{formatMinutes(d.light_min)}</td>
                  <td>{formatMinutes(d.rem_min)}</td>
                  <td>{formatMinutes(d.awake_min)}</td>
                  <td style="min-width:120px">
                    <SleepBar deep={d.deep_min} light={d.light_min} rem={d.rem_min} awake={d.awake_min} />
                  </td>
                  <td>{round(d.average_hr_sleep, 0)} bpm</td>
                  <td>
                    <FeedbackBadge feedback={d.sleep_score_feedback} insight={d.sleep_score_insight} />
                  </td>
                </tr>
                {expandedDate === d.calendar_date && (
                  <tr key={`${d.calendar_date}-detail`}>
                    <td colspan={9} style="padding:0;background:var(--bg-card)">
                      <NightDetail date={d.calendar_date} />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
