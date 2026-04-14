import { useApi } from "../lib/hooks";
import { round, formatDate, formatDistanceMeters, formatDuration, metersToMiles } from "../lib/format";
import { MetricCard } from "../components/MetricCard";
import { Sparkline } from "../components/Sparkline";

interface TrainingData {
  readiness: Array<{
    calendar_date: string;
    score: number;
    level: string;
    feedback_short: string;
    recovery_time: number;
    recovery_time_factor_percent: number;
    hrv_factor_percent: number;
    hrv_weekly_average: number;
    sleep_history_factor_percent: number;
    stress_history_factor_percent: number;
    acwr_factor_percent: number;
  }>;
  endurance: Array<{
    calendar_date: string;
    overall_score: number;
    classification: string;
    vo2_max_precise: number;
  }>;
  hill: Array<{
    calendar_date: string;
    overall_score: number;
    endurance_score: number;
    strength_score: number;
  }>;
  race_predictions: Array<{
    calendar_date: string;
    time_5k: number;
    time_10k: number;
    time_half_marathon: number;
    time_marathon: number;
  }>;
}

interface PersonalRecord {
  display_name: string;
  activity_type: string;
  pr_type: number;
  value: number;
  pr_date: string;
  activity_id: number;
}

const PR_TYPE_LABELS: Record<number, { label: string; unit: string; format: (v: number) => string }> = {
  1: { label: "Fastest Distance", unit: "mi", format: (v) => `${round(metersToMiles(v), 2)}mi` },
  2: { label: "Fastest Distance", unit: "mi", format: (v) => `${round(metersToMiles(v), 2)}mi` },
  3: { label: "Longest Distance", unit: "mi", format: (v) => formatDistanceMeters(v) },
  7: { label: "Longest Run", unit: "mi", format: (v) => formatDistanceMeters(v) },
};

function levelBadge(level?: string) {
  if (!level) return null;
  const cls = level === "PRIME" || level === "PRODUCTIVE" ? "badge-green"
    : level === "RECOVERY" || level === "MAINTAINING" ? "badge-yellow" : "badge-red";
  return <span class={`badge ${cls}`}>{level}</span>;
}

function factorColor(pct: number): string {
  if (pct >= 70) return "#22c55e";
  if (pct >= 40) return "#f59e0b";
  return "#ef4444";
}

function FactorBar({ label, pct }: { label: string; pct: number }) {
  if (pct == null) return null;
  const color = factorColor(pct);
  return (
    <div style="margin-bottom:0.5rem">
      <div style="display:flex;justify-content:space-between;font-size:0.75rem;margin-bottom:0.125rem">
        <span style="color:var(--text-dim)">{label}</span>
        <span style={`color:${color};font-weight:600`}>{Math.round(pct)}%</span>
      </div>
      <div style="height:6px;background:var(--bg);border-radius:3px;overflow:hidden">
        <div style={`width:${Math.min(pct, 100)}%;height:100%;background:${color};border-radius:3px`} />
      </div>
    </div>
  );
}

export function Training() {
  const { data, loading } = useApi<TrainingData>("/health/training", { days: "30" });
  const { data: prs } = useApi<PersonalRecord[]>("/health/personal-records");

  if (loading) return <div class="loading">Loading...</div>;
  if (!data) return <div class="loading">No training data</div>;

  const latestR = data.readiness[data.readiness.length - 1];
  const latestE = data.endurance[data.endurance.length - 1];
  const latestH = data.hill[data.hill.length - 1];
  const latestRace = data.race_predictions[data.race_predictions.length - 1];

  return (
    <div>
      <div class="page-header">
        <h1>Training</h1>
        {latestR?.feedback_short && (
          <p style="color:var(--color-training);font-size:0.85rem">
            {latestR.feedback_short.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c: string) => c.toUpperCase())}
          </p>
        )}
      </div>

      <div class="cards">
        <MetricCard
          label="Training Readiness"
          value={latestR?.score != null ? Math.round(latestR.score) : "--"}
          color="var(--color-training)"
          sub={latestR?.recovery_time ? `Recovery: ${Math.round(latestR.recovery_time)}h` : ""}
        >
          {levelBadge(latestR?.level)}
          <Sparkline data={data.readiness.map((r) => r.score).filter(Boolean) as number[]} color="var(--color-training)" />
        </MetricCard>

        <MetricCard
          label="Endurance Score"
          value={latestE?.overall_score ?? "--"}
          color="var(--color-battery)"
          sub={latestE?.classification ?? ""}
        >
          <Sparkline data={data.endurance.map((e) => e.overall_score).filter(Boolean) as number[]} color="var(--color-battery)" />
        </MetricCard>

        <MetricCard
          label="VO2 Max"
          value={latestE?.vo2_max_precise != null ? round(latestE.vo2_max_precise) : "--"}
          color="var(--color-hrv)"
        >
          <Sparkline data={data.endurance.map((e) => e.vo2_max_precise).filter(Boolean) as number[]} color="var(--color-hrv)" />
        </MetricCard>

        <MetricCard
          label="Hill Score"
          value={latestH?.overall_score ?? "--"}
          color="var(--color-stress)"
          sub={latestH ? `End: ${latestH.endurance_score} | Str: ${latestH.strength_score}` : ""}
        >
          <Sparkline data={data.hill.map((h) => h.overall_score).filter(Boolean) as number[]} color="var(--color-stress)" />
        </MetricCard>
      </div>

      {/* Race Predictions */}
      {latestRace && (
        <div class="cards">
          <MetricCard label="5K" value={formatDuration(latestRace.time_5k)} color="var(--color-steps)">
            {data.race_predictions.length > 1 && (
              <Sparkline data={data.race_predictions.map((r) => -r.time_5k).filter(Boolean) as number[]} color="var(--color-steps)" />
            )}
          </MetricCard>
          <MetricCard label="10K" value={formatDuration(latestRace.time_10k)} color="var(--color-steps)">
            {data.race_predictions.length > 1 && (
              <Sparkline data={data.race_predictions.map((r) => -r.time_10k).filter(Boolean) as number[]} color="var(--color-steps)" />
            )}
          </MetricCard>
          <MetricCard label="Half Marathon" value={formatDuration(latestRace.time_half_marathon)} color="var(--color-steps)" />
          <MetricCard label="Marathon" value={formatDuration(latestRace.time_marathon)} color="var(--color-steps)" />
        </div>
      )}

      {/* Readiness Factor Breakdown for latest day */}
      {latestR && (
        <div class="chart-container">
          <h3>Readiness Factors (Latest)</h3>
          <FactorBar label="Recovery Time" pct={latestR.recovery_time_factor_percent} />
          <FactorBar label="HRV" pct={latestR.hrv_factor_percent} />
          <FactorBar label="Sleep History" pct={latestR.sleep_history_factor_percent} />
          <FactorBar label="Stress History" pct={latestR.stress_history_factor_percent} />
          <FactorBar label="Training Load (ACWR)" pct={latestR.acwr_factor_percent} />
        </div>
      )}

      {/* Personal Records */}
      {prs && prs.length > 0 && (
        <div class="table-wrap">
          <h3>Personal Records</h3>
          <table>
            <thead>
              <tr>
                <th>Activity</th>
                <th>Type</th>
                <th>Record</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {prs.map((pr, i) => {
                const typeInfo = PR_TYPE_LABELS[pr.pr_type];
                return (
                  <tr key={i}>
                    <td>{pr.display_name}</td>
                    <td><span class="badge badge-blue">{pr.activity_type}</span></td>
                    <td style="font-weight:600">
                      {typeInfo ? typeInfo.format(pr.value) : `${round(pr.value, 1)}`}
                    </td>
                    <td>{pr.pr_date ? formatDate(pr.pr_date) : "--"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Readiness History */}
      {data.readiness.length > 0 && (
        <div class="table-wrap">
          <h3>Readiness History</h3>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Score</th>
                <th>Level</th>
                <th>Recovery</th>
                <th>HRV</th>
                <th>Sleep</th>
                <th>Stress</th>
                <th>Workload</th>
              </tr>
            </thead>
            <tbody>
              {[...data.readiness].reverse().map((r) => (
                <tr key={r.calendar_date}>
                  <td>{formatDate(r.calendar_date)}</td>
                  <td style="font-weight:600">{Math.round(r.score)}</td>
                  <td>{levelBadge(r.level)}</td>
                  <td style={`color:${factorColor(r.recovery_time_factor_percent)}`}>
                    {r.recovery_time_factor_percent != null ? `${Math.round(r.recovery_time_factor_percent)}%` : "--"}
                  </td>
                  <td style={`color:${factorColor(r.hrv_factor_percent)}`}>
                    {r.hrv_factor_percent != null ? `${Math.round(r.hrv_factor_percent)}%` : "--"}
                  </td>
                  <td style={`color:${factorColor(r.sleep_history_factor_percent)}`}>
                    {r.sleep_history_factor_percent != null ? `${Math.round(r.sleep_history_factor_percent)}%` : "--"}
                  </td>
                  <td style={`color:${factorColor(r.stress_history_factor_percent)}`}>
                    {r.stress_history_factor_percent != null ? `${Math.round(r.stress_history_factor_percent)}%` : "--"}
                  </td>
                  <td style={`color:${factorColor(r.acwr_factor_percent)}`}>
                    {r.acwr_factor_percent != null ? `${Math.round(r.acwr_factor_percent)}%` : "--"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
