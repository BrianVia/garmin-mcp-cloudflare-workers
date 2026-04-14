import { useApi } from "../lib/hooks";
import { round, formatDate, formatDistanceKm, formatMinutes } from "../lib/format";
import { MetricCard } from "../components/MetricCard";
import { Sparkline } from "../components/Sparkline";
import { SleepBar } from "../components/SleepBar";

interface DailyRow {
  calendar_date: string;
  total_steps: number;
  daily_step_goal: number;
  resting_heart_rate: number;
  average_stress_level: number;
  body_battery_highest: number;
  body_battery_lowest: number;
  body_battery_charged: number;
  body_battery_drained: number;
  body_battery_at_wake: number;
  average_spo2: number;
  floors_ascended: number;
  total_kilocalories: number;
  active_kilocalories: number;
  moderate_intensity_minutes: number;
  vigorous_intensity_minutes: number;
  intensity_minutes_goal: number;
  low_stress_seconds: number;
  medium_stress_seconds: number;
  high_stress_seconds: number;
}

interface SleepRow {
  calendar_date: string;
  sleep_hours: number;
  deep_min: number;
  light_min: number;
  rem_min: number;
  awake_min: number;
  average_hr_sleep: number;
}

interface TrainingRow {
  calendar_date: string;
  score: number;
  level: string;
  feedback_short: string;
  recovery_time: number;
}

interface HrvRow {
  calendar_date: string;
  weekly_avg: number;
  last_night: number;
  status: string;
  baseline_low: number;
  baseline_upper: number;
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

interface Activity {
  id: number;
  name: string;
  type: string;
  date: string;
  duration_min: number;
  distance_km: number;
  avg_hr: number;
}

interface DashboardData {
  daily: DailyRow[];
  sleep: SleepRow[];
  training: TrainingRow[];
  hrv: HrvRow[];
  fitness_age: { chronological_age: number; fitness_age: number } | null;
  body_battery: BatteryRow[];
}

function StressBar({ low, med, high }: { low: number; med: number; high: number }) {
  const total = low + med + high;
  if (!total) return null;
  const pct = (v: number) => `${((v / total) * 100).toFixed(0)}%`;
  return (
    <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;gap:1px;margin-top:0.5rem">
      <div style={`width:${pct(low)};background:#22c55e`} title={`Low: ${Math.round(low / 60)}m`} />
      <div style={`width:${pct(med)};background:#f59e0b`} title={`Med: ${Math.round(med / 60)}m`} />
      <div style={`width:${pct(high)};background:#ef4444`} title={`High: ${Math.round(high / 60)}m`} />
    </div>
  );
}

function ProgressRing({ value, goal, color }: { value: number; goal: number; color: string }) {
  const pct = Math.min((value / goal) * 100, 100);
  const r = 18;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;
  return (
    <svg width="44" height="44" style="margin-top:0.5rem">
      <circle cx="22" cy="22" r={r} fill="none" stroke="var(--border)" stroke-width="4" />
      <circle
        cx="22" cy="22" r={r} fill="none" stroke={color} stroke-width="4"
        stroke-dasharray={circ} stroke-dashoffset={offset}
        stroke-linecap="round" transform="rotate(-90 22 22)"
      />
      <text x="22" y="22" text-anchor="middle" dominant-baseline="central"
        fill={color} font-size="10" font-weight="600">
        {Math.round(pct)}%
      </text>
    </svg>
  );
}

function levelBadge(level?: string) {
  if (!level) return null;
  const cls = level === "PRIME" || level === "PRODUCTIVE" ? "badge-green"
    : level === "RECOVERY" || level === "MAINTAINING" ? "badge-yellow" : "badge-red";
  return <span class={`badge ${cls}`}>{level}</span>;
}

function hrvStatusBadge(status?: string) {
  if (!status) return null;
  const cls = status === "BALANCED" ? "badge-green"
    : status === "LOW" || status === "UNBALANCED" ? "badge-red" : "badge-yellow";
  return <span class={`badge ${cls}`}>{status}</span>;
}

export function Dashboard() {
  const { data: dash, loading: l1 } = useApi<DashboardData>("/health/dashboard");
  const { data: activities, loading: l2 } = useApi<Activity[]>("/activities", { limit: "5" });

  if (l1 || l2) return <div class="loading">Loading...</div>;
  if (!dash) return <div class="loading">No data</div>;

  const latest = dash.daily[dash.daily.length - 1];
  const latestSleep = dash.sleep[dash.sleep.length - 1];
  const latestTraining = dash.training[dash.training.length - 1];
  const latestHrv = dash.hrv[dash.hrv.length - 1];
  const latestBattery = dash.body_battery[dash.body_battery.length - 1];
  const fa = dash.fitness_age;

  const intensityMin = latest ? (latest.moderate_intensity_minutes || 0) + (latest.vigorous_intensity_minutes || 0) : 0;
  const intensityGoal = latest?.intensity_minutes_goal || 150;

  return (
    <div>
      <div class="page-header">
        <h1>Dashboard</h1>
        <p>
          {latest && (
            <span style="color:var(--text-dim);font-size:0.85rem">
              {new Date(latest.calendar_date + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
            </span>
          )}
          {latestTraining?.feedback_short && (
            <span style="color:var(--color-training);font-size:0.85rem;margin-left:0.75rem">
              {latestTraining.feedback_short.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c: string) => c.toUpperCase())}
            </span>
          )}
        </p>
      </div>

      {/* Row 1: Key health metrics */}
      <div class="cards">
        <MetricCard
          label="Training Readiness"
          value={latestTraining?.score != null ? Math.round(latestTraining.score) : "--"}
          color="var(--color-training)"
          href="/training"
          sub={latestTraining?.recovery_time ? `Recovery: ${Math.round(latestTraining.recovery_time)}h` : ""}
        >
          {levelBadge(latestTraining?.level)}
          <Sparkline
            data={dash.training.map((r) => r.score).filter(Boolean) as number[]}
            color="var(--color-training)"
          />
        </MetricCard>

        <MetricCard
          label="HRV"
          value={latestHrv?.last_night ?? latestHrv?.weekly_avg ?? "--"}
          unit="ms"
          color="var(--color-hrv)"
          href="/training"
          sub={latestHrv ? `Weekly: ${round(latestHrv.weekly_avg)} · Range: ${Math.round(latestHrv.baseline_low || 0)}-${Math.round(latestHrv.baseline_upper || 0)}` : ""}
        >
          {hrvStatusBadge(latestHrv?.status)}
          <Sparkline
            data={dash.hrv.map((h) => h.last_night || h.weekly_avg).filter(Boolean) as number[]}
            color="var(--color-hrv)"
          />
        </MetricCard>

        <MetricCard
          label="Resting HR"
          value={latest?.resting_heart_rate ?? "--"}
          unit="bpm"
          color="var(--color-hr)"
          href="/heart-rate"
        >
          <Sparkline
            data={dash.daily.map((d) => d.resting_heart_rate).filter(Boolean) as number[]}
            color="var(--color-hr)"
          />
        </MetricCard>

        <MetricCard
          label="Body Battery"
          value={latestBattery?.highest ?? latest?.body_battery_highest ?? "--"}
          color="var(--color-battery)"
          href="/stress"
          sub={latestBattery ? `Wake: ${latestBattery.at_wake} · +${latestBattery.charged}/-${latestBattery.drained}` : ""}
        >
          <Sparkline
            data={dash.body_battery.length > 0
              ? dash.body_battery.map((b) => b.highest).filter(Boolean) as number[]
              : dash.daily.map((d) => d.body_battery_highest).filter(Boolean) as number[]}
            color="var(--color-battery)"
          />
        </MetricCard>

        <MetricCard
          label="Sleep"
          value={latestSleep?.sleep_hours != null ? round(latestSleep.sleep_hours) : "--"}
          unit="hrs"
          color="var(--color-sleep)"
          href="/sleep"
        >
          {latestSleep && (
            <SleepBar
              deep={latestSleep.deep_min} light={latestSleep.light_min}
              rem={latestSleep.rem_min} awake={latestSleep.awake_min}
            />
          )}
        </MetricCard>

        <MetricCard
          label="Stress"
          value={latest?.average_stress_level ?? "--"}
          color="var(--color-stress)"
          href="/stress"
        >
          {latest && (
            <StressBar
              low={latest.low_stress_seconds || 0}
              med={latest.medium_stress_seconds || 0}
              high={latest.high_stress_seconds || 0}
            />
          )}
          <Sparkline
            data={dash.daily.map((d) => d.average_stress_level).filter(Boolean) as number[]}
            color="var(--color-stress)"
          />
        </MetricCard>

        <MetricCard
          label="Steps"
          value={latest?.total_steps?.toLocaleString() ?? "--"}
          color="var(--color-steps)"
          href="/trends"
        >
          {latest?.daily_step_goal && (
            <ProgressRing value={latest.total_steps || 0} goal={latest.daily_step_goal} color="var(--color-steps)" />
          )}
        </MetricCard>

        <MetricCard
          label="Intensity Min"
          value={intensityMin}
          color="var(--accent)"
          href="/trends"
          sub={`Goal: ${intensityGoal}`}
        >
          <ProgressRing value={intensityMin} goal={intensityGoal} color="var(--accent)" />
        </MetricCard>

        <MetricCard
          label="Calories"
          value={latest?.total_kilocalories ? Math.round(latest.total_kilocalories).toLocaleString() : "--"}
          unit="kcal"
          color="var(--color-stress)"
          href="/trends"
          sub={latest?.active_kilocalories ? `Active: ${Math.round(latest.active_kilocalories)}` : ""}
        />

        {fa && (
          <MetricCard
            label="Fitness Age"
            value={round(fa.fitness_age, 0)}
            color="var(--color-hrv)"
            href="/training"
            sub={`Actual: ${fa.chronological_age}`}
          />
        )}

        <MetricCard
          label="SpO2"
          value={latest?.average_spo2 != null ? round(latest.average_spo2) : "--"}
          unit="%"
          color="var(--color-spo2)"
          href="/trends"
        />

        <MetricCard
          label="Floors"
          value={latest?.floors_ascended != null ? round(latest.floors_ascended, 0) : "--"}
          color="var(--color-steps)"
          href="/trends"
        >
          <Sparkline
            data={dash.daily.map((d) => d.floors_ascended).filter(Boolean) as number[]}
            color="var(--color-steps)"
          />
        </MetricCard>
      </div>

      {/* Recent Activities */}
      <div class="table-wrap">
        <h3>Recent Activities</h3>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Activity</th>
              <th>Type</th>
              <th>Duration</th>
              <th>Distance</th>
              <th>Avg HR</th>
            </tr>
          </thead>
          <tbody>
            {activities?.map((a) => (
              <tr key={a.id}>
                <td>{formatDate(a.date?.slice(0, 10) ?? "")}</td>
                <td>{a.name}</td>
                <td><span class="badge badge-blue">{a.type}</span></td>
                <td>{a.duration_min ? `${Math.round(a.duration_min)}m` : "--"}</td>
                <td>{a.distance_km ? formatDistanceKm(a.distance_km) : "--"}</td>
                <td>{a.avg_hr ? `${Math.round(a.avg_hr)} bpm` : "--"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
