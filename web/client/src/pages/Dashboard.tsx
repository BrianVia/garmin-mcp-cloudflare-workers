import { useState } from "preact/hooks";
import { useApi } from "../lib/hooks";
import { round, formatDate, formatDistanceKm } from "../lib/format";
import { MetricCard } from "../components/MetricCard";
import { Sparkline } from "../components/Sparkline";
import { SleepBar } from "../components/SleepBar";
import { ActivityDetail } from "../components/ActivityDetail";

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
    <div style="display:flex;height:6px;border-radius:2px;overflow:hidden;gap:1px;margin-top:0.5rem;background:var(--ink-raised)">
      <div style={`width:${pct(low)};background:var(--moss)`} title={`Low: ${Math.round(low / 60)}m`} />
      <div style={`width:${pct(med)};background:var(--ochre)`} title={`Med: ${Math.round(med / 60)}m`} />
      <div style={`width:${pct(high)};background:var(--crimson)`} title={`High: ${Math.round(high / 60)}m`} />
    </div>
  );
}

function ProgressArc({ value, goal, color }: { value: number; goal: number; color: string }) {
  const pct = Math.min((value / goal) * 100, 100);
  const r = 22;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;
  return (
    <svg width="56" height="56" style="margin-top:0.5rem" viewBox="0 0 56 56">
      <circle cx="28" cy="28" r={r} fill="none" stroke="var(--rule-2)" stroke-width="3" />
      <circle
        cx="28" cy="28" r={r} fill="none" stroke={color} stroke-width="3"
        stroke-dasharray={circ} stroke-dashoffset={offset}
        stroke-linecap="round" transform="rotate(-90 28 28)"
        style="transition:stroke-dashoffset 0.8s cubic-bezier(0.2,0.7,0.2,1)"
      />
      <text x="28" y="28" text-anchor="middle" dominant-baseline="central"
        fill="var(--fg-1)" font-size="12" font-family="var(--font-sans)" font-weight="700"
        letter-spacing="-0.02em">
        {Math.round(pct)}%
      </text>
    </svg>
  );
}

function ReadinessRing({ score, color }: { score: number | null; color: string }) {
  const r = 112;
  const circ = 2 * Math.PI * r;
  const pct = score != null ? Math.min(Math.max(score, 0), 100) / 100 : 0;
  const offset = circ - pct * circ;
  const gradId = "readiness-ring-grad";
  return (
    <div class="readiness-ring">
      <svg viewBox="0 0 260 260">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color={color} stop-opacity="0.85" />
            <stop offset="100%" stop-color={color} stop-opacity="1" />
          </linearGradient>
        </defs>
        <circle class="ring-track" cx="130" cy="130" r={r} fill="none" stroke-width="8" />
        <circle
          class="ring-fill"
          cx="130" cy="130" r={r} fill="none"
          stroke={`url(#${gradId})`} stroke-width="8"
          stroke-dasharray={circ}
          stroke-dashoffset={offset}
          style={`color:${color}`}
        />
      </svg>
      <div class="ring-inner">
        <div class="ring-label">Readiness</div>
        <div class="ring-num">{score ?? "—"}</div>
        <div class="ring-sub">out of 100</div>
      </div>
    </div>
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

function scoreTone(score: number | undefined): string {
  if (score == null) return "teal";
  if (score >= 75) return "teal";
  if (score >= 50) return "mint";
  if (score >= 25) return "amber";
  return "coral";
}

function toneColor(tone: string): string {
  return `var(--${tone})`;
}

function readinessPhrase(level?: string): { text: string; em: string } {
  if (!level) return { text: "Signals steady —", em: "day unfolding." };
  const map: Record<string, { text: string; em: string }> = {
    PRIME: { text: "Every system green —", em: "chase something hard." },
    PRODUCTIVE: { text: "Well-rested and sharp —", em: "do the work." },
    MAINTAINING: { text: "Holding the line —", em: "stay the course." },
    RECOVERY: { text: "Recovery in progress —", em: "move gently." },
    LOW: { text: "Reserves are thin —", em: "take it easy." },
    POOR: { text: "Strain accumulated —", em: "rest is the training." },
  };
  return map[level] ?? { text: "Reading the signals —", em: "see below." };
}

export function Dashboard() {
  const { data: dash, loading: l1 } = useApi<DashboardData>("/health/dashboard");
  const { data: activities, loading: l2 } = useApi<Activity[]>("/activities", { limit: "6" });
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (l1 || l2) return <div class="loading">Pulling your data</div>;
  if (!dash) return <div class="loading">No data</div>;

  const latest = dash.daily[dash.daily.length - 1];
  const latestSleep = dash.sleep[dash.sleep.length - 1];
  const latestTraining = dash.training[dash.training.length - 1];
  const latestHrv = dash.hrv[dash.hrv.length - 1];
  const latestBattery = dash.body_battery[dash.body_battery.length - 1];
  const fa = dash.fitness_age;

  const intensityMin = latest ? (latest.moderate_intensity_minutes || 0) + (latest.vigorous_intensity_minutes || 0) : 0;
  const intensityGoal = latest?.intensity_minutes_goal || 150;

  const readinessScore = latestTraining?.score != null ? Math.round(latestTraining.score) : null;
  const tone = scoreTone(readinessScore ?? undefined);
  const phrase = readinessPhrase(latestTraining?.level);

  const dateStr = latest
    ? new Date(latest.calendar_date + "T00:00:00").toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric", year: "numeric",
      })
    : "";

  const ringColor = toneColor(tone);

  return (
    <div>
      <div class="page-header">
        <div class="eyebrow">Today</div>
        <h1>
          Your <em>daily</em> signals
        </h1>
        <div class="dateline">
          <span>{dateStr}</span>
          {latestTraining?.feedback_short && (
            <>
              <span class="sep">·</span>
              <span class="accent">
                {latestTraining.feedback_short.replace(/_/g, " ").toLowerCase()}
              </span>
            </>
          )}
          <span class="sep">·</span>
          <span>{dash.daily.length}-day window</span>
        </div>
      </div>

      {/* HERO — Oura-style readiness ring with stat tiles */}
      <section class="hero">
        <div class="hero-main">
          <ReadinessRing score={readinessScore} color={ringColor} />
          <div class="hero-pullquote">
            {phrase.text} <em>{phrase.em}</em>
          </div>
          <div style="display:flex;gap:0.5rem;margin-top:0.75rem;align-items:center;flex-wrap:wrap;justify-content:center">
            {levelBadge(latestTraining?.level)}
            {latestTraining?.recovery_time != null && (
              <span style="font-size:0.75rem;color:var(--fg-3);font-weight:500">
                Recovery · {Math.round(latestTraining.recovery_time)}h
              </span>
            )}
          </div>
        </div>

        <div class="hero-side">
          <div class="hero-kpi">
            <div class={`kpi-num ${latestHrv?.status === "BALANCED" ? "teal" : latestHrv?.status === "LOW" ? "crimson" : "ochre"}`}>
              {latestHrv?.last_night ?? latestHrv?.weekly_avg ?? "—"}
              <span style="font-size:0.55em;color:var(--fg-3);margin-left:0.25em;font-weight:500">ms</span>
            </div>
            <div class="kpi-meta">
              <div class="kpi-label">HRV — overnight</div>
              <div class="kpi-sub">
                {latestHrv
                  ? `baseline ${Math.round(latestHrv.baseline_low || 0)}–${Math.round(latestHrv.baseline_upper || 0)} · ${latestHrv.status?.toLowerCase()}`
                  : "—"}
              </div>
            </div>
          </div>

          <div class="hero-kpi">
            <div class="kpi-num indigo">
              {latestSleep?.sleep_hours != null ? round(latestSleep.sleep_hours) : "—"}
              {latestSleep?.sleep_hours != null && <span style="font-size:0.55em;color:var(--fg-3);margin-left:0.25em;font-weight:500">hrs</span>}
            </div>
            <div class="kpi-meta">
              <div class="kpi-label">Sleep — last night</div>
              <div class="kpi-sub">
                {latestSleep
                  ? `deep ${Math.round(latestSleep.deep_min)}m · rem ${Math.round(latestSleep.rem_min)}m`
                  : "—"}
              </div>
            </div>
          </div>

          <div class="hero-kpi">
            <div class="kpi-num crimson">
              {latest?.resting_heart_rate ?? "—"}
              <span style="font-size:0.55em;color:var(--fg-3);margin-left:0.25em;font-weight:500">bpm</span>
            </div>
            <div class="kpi-meta">
              <div class="kpi-label">Resting HR</div>
              <div class="kpi-sub">
                {dash.daily.filter((d) => d.resting_heart_rate).length}-day data
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Signals section */}
      <div class="section-rule">
        <div class="section-rule-num">I.</div>
        <div class="section-rule-title">Signals</div>
        <div class="section-rule-line"></div>
        <div class="section-rule-meta">{dash.daily.length} days</div>
      </div>

      <div class="cards">
        <MetricCard
          label="Body Battery"
          value={latestBattery?.highest ?? latest?.body_battery_highest ?? "--"}
          color="var(--teal)"
          href="/stress"
          sub={latestBattery ? `wake ${latestBattery.at_wake} · +${latestBattery.charged}/-${latestBattery.drained}` : ""}
        >
          <Sparkline
            data={dash.body_battery.length > 0
              ? dash.body_battery.map((b) => b.highest).filter(Boolean) as number[]
              : dash.daily.map((d) => d.body_battery_highest).filter(Boolean) as number[]}
            color="var(--teal)"
          />
        </MetricCard>

        <MetricCard
          label="Sleep"
          value={latestSleep?.sleep_hours != null ? round(latestSleep.sleep_hours) : "--"}
          unit="hrs"
          color="var(--indigo)"
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
          color="var(--rust)"
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
            color="var(--rust)"
          />
        </MetricCard>

        <MetricCard
          label="Steps"
          value={latest?.total_steps?.toLocaleString() ?? "--"}
          color="var(--moss)"
          href="/trends"
          sub={latest?.daily_step_goal ? `goal ${latest.daily_step_goal.toLocaleString()}` : ""}
        >
          {latest?.daily_step_goal && (
            <ProgressArc value={latest.total_steps || 0} goal={latest.daily_step_goal} color="var(--moss)" />
          )}
        </MetricCard>

        <MetricCard
          label="Intensity"
          value={intensityMin}
          unit="min"
          color="var(--rust)"
          href="/trends"
          sub={`goal ${intensityGoal}`}
        >
          <ProgressArc value={intensityMin} goal={intensityGoal} color="var(--rust)" />
        </MetricCard>

        <MetricCard
          label="Calories"
          value={latest?.total_kilocalories ? Math.round(latest.total_kilocalories).toLocaleString() : "--"}
          unit="kcal"
          color="var(--ochre)"
          href="/trends"
          sub={latest?.active_kilocalories ? `active ${Math.round(latest.active_kilocalories)}` : ""}
        />

        {fa && (
          <MetricCard
            label="Fitness Age"
            value={round(fa.fitness_age, 0)}
            color="var(--teal)"
            href="/training"
            sub={`actual ${fa.chronological_age}`}
          />
        )}

        <MetricCard
          label="SpO₂"
          value={latest?.average_spo2 != null ? round(latest.average_spo2) : "--"}
          unit="%"
          color="var(--slate)"
          href="/trends"
        />

        <MetricCard
          label="Floors"
          value={latest?.floors_ascended != null ? round(latest.floors_ascended, 0) : "--"}
          color="var(--moss)"
          href="/trends"
        >
          <Sparkline
            data={dash.daily.map((d) => d.floors_ascended).filter(Boolean) as number[]}
            color="var(--moss)"
          />
        </MetricCard>
      </div>

      {/* Recent Activities */}
      <div class="section-rule">
        <div class="section-rule-num">II.</div>
        <div class="section-rule-title">The ledger</div>
        <div class="section-rule-line"></div>
        <div class="section-rule-meta">latest {activities?.length ?? 0}</div>
      </div>

      <div class="table-wrap">
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
              <>
                <tr
                  key={a.id}
                  onClick={() => setExpandedId(expandedId === a.id ? null : a.id)}
                  style="cursor:pointer"
                >
                  <td>{formatDate(a.date?.slice(0, 10) ?? "")}</td>
                  <td>{a.name}</td>
                  <td><span class="badge badge-blue">{a.type}</span></td>
                  <td>{a.duration_min ? `${Math.round(a.duration_min)}m` : "--"}</td>
                  <td>{a.distance_km ? formatDistanceKm(a.distance_km) : "--"}</td>
                  <td>{a.avg_hr ? `${Math.round(a.avg_hr)} bpm` : "--"}</td>
                </tr>
                {expandedId === a.id && (
                  <tr key={`${a.id}-detail`}>
                    <td colspan={6} style="padding:0;background:var(--paper)">
                      <ActivityDetail id={a.id} />
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
