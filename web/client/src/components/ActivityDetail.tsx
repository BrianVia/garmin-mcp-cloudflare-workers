import { useApi } from "../lib/hooks";
import { formatDuration, formatPace, metersToMiles, msToMph, round } from "../lib/format";
import { CopyButtons } from "./CopyButtons";

interface ActivityData {
  activity: {
    id: number;
    name: string;
    type: string;
    date: string;
    duration_seconds: number;
    elapsed_duration_seconds: number;
    moving_duration_seconds: number;
    distance_meters: number;
    calories: number;
    bmr_calories: number;
    average_hr: number;
    max_hr: number;
    average_speed: number;
    max_speed: number;
    elevation_gain: number;
    elevation_loss: number;
    avg_power: number;
    max_power: number;
    norm_power: number;
    training_stress_score: number;
    intensity_factor: number;
    aerobic_training_effect: number;
    anaerobic_training_effect: number;
    vo2max_value: number;
    avg_cadence: number;
    max_cadence: number;
    avg_respiration: number;
    training_load: number;
    location_name: string;
    start_latitude: number;
    start_longitude: number;
  };
  splits: Array<{
    split_number: number;
    distance_meters: number;
    duration_seconds: number;
    average_speed: number;
    average_hr: number;
    max_hr: number;
    elevation_gain: number;
    elevation_loss: number;
    avg_cadence: number;
  }>;
  hr_zones: {
    zone1_seconds: number;
    zone2_seconds: number;
    zone3_seconds: number;
    zone4_seconds: number;
    zone5_seconds: number;
  } | null;
  weather: {
    temperature: number;
    apparent_temperature: number;
    humidity: number;
    wind_speed: number;
    weather_type: string;
  } | null;
  exercise_sets: Array<{
    set_number: number;
    exercise_name: string;
    exercise_category: string;
    reps: number;
    weight: number;
    duration_seconds: number;
  }>;
}

function TrainingEffectGauge({ value, label, color }: { value: number; label: string; color: string }) {
  if (!value) return null;
  const pct = Math.min((value / 5) * 100, 100);
  const effectLabel =
    value < 1 ? "None" : value < 2 ? "Minor" : value < 3 ? "Maintaining" : value < 4 ? "Improving" : "Overreaching";

  return (
    <div style="flex:1;min-width:120px">
      <div style="font-size:0.7rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.25rem">
        {label}
      </div>
      <div style="display:flex;align-items:center;gap:0.5rem">
        <div style="flex:1;height:6px;background:var(--bg);border-radius:3px;overflow:hidden">
          <div style={`width:${pct}%;height:100%;background:${color};border-radius:3px`} />
        </div>
        <span style={`font-size:0.875rem;font-weight:600;color:${color}`}>{value.toFixed(1)}</span>
      </div>
      <div style="font-size:0.7rem;color:var(--text-dim);margin-top:0.125rem">{effectLabel}</div>
    </div>
  );
}

function HrZoneBar({ zones }: { zones: ActivityData["hr_zones"] }) {
  if (!zones) return null;
  const entries = [
    { label: "Z1", seconds: zones.zone1_seconds, color: "#7b8fa1" },
    { label: "Z2", seconds: zones.zone2_seconds, color: "#5aa39b" },
    { label: "Z3", seconds: zones.zone3_seconds, color: "#7ea067" },
    { label: "Z4", seconds: zones.zone4_seconds, color: "#d4a757" },
    { label: "Z5", seconds: zones.zone5_seconds, color: "#d2554f" },
  ];
  const total = entries.reduce((s, e) => s + (e.seconds || 0), 0);
  if (!total) return null;

  return (
    <div>
      <div style="font-size:0.7rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem">
        HR Zones
      </div>
      <div style="display:flex;height:24px;border-radius:4px;overflow:hidden;gap:1px">
        {entries.map((e) =>
          e.seconds > 0 ? (
            <div
              key={e.label}
              title={`${e.label}: ${formatDuration(e.seconds)}`}
              style={{
                width: `${(e.seconds / total) * 100}%`,
                background: e.color,
                minWidth: "2px",
              }}
            />
          ) : null
        )}
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:0.375rem">
        {entries.map((e) =>
          e.seconds > 0 ? (
            <span key={e.label} style={`font-size:0.7rem;color:${e.color}`}>
              {e.label} {formatDuration(e.seconds)}
            </span>
          ) : null
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, unit }: { label: string; value: string | number | null; unit?: string }) {
  if (value == null || value === 0) return null;
  return (
    <div style="text-align:center;min-width:80px">
      <div style="font-size:0.65rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em">{label}</div>
      <div style="font-size:1.125rem;font-weight:600;color:var(--text-bright)">
        {value}{unit && <span style="font-size:0.75rem;color:var(--text-dim);margin-left:2px">{unit}</span>}
      </div>
    </div>
  );
}

function buildMarkdown(data: ActivityData): string {
  const a = data.activity;
  const isRunning = a.type?.includes("running");
  const lines: string[] = [];

  lines.push(`# ${a.name || "Activity"}`);
  if (a.date) lines.push(`*${new Date(a.date).toLocaleString()}*`);
  if (a.type) lines.push(`**Type:** ${a.type}`);
  if (a.location_name) lines.push(`**Location:** ${a.location_name}`);
  lines.push("");

  lines.push("## Summary");
  const stat = (label: string, value: string | number | null | undefined) => {
    if (value == null || value === "" || value === 0) return;
    lines.push(`- **${label}:** ${value}`);
  };
  stat("Duration", formatDuration(a.duration_seconds));
  if (a.moving_duration_seconds && a.moving_duration_seconds !== a.duration_seconds) {
    stat("Moving time", formatDuration(a.moving_duration_seconds));
  }
  if (a.distance_meters > 0) stat("Distance", `${round(metersToMiles(a.distance_meters), 2)} mi`);
  if (a.average_speed > 0) {
    stat(isRunning ? "Avg pace" : "Avg speed",
      isRunning ? formatPace(a.average_speed) : `${round(msToMph(a.average_speed), 1)} mph`);
  }
  if (a.max_speed > 0) {
    stat(isRunning ? "Best pace" : "Max speed",
      isRunning ? formatPace(a.max_speed) : `${round(msToMph(a.max_speed), 1)} mph`);
  }
  stat("Avg HR", a.average_hr ? `${Math.round(a.average_hr)} bpm` : null);
  stat("Max HR", a.max_hr ? `${Math.round(a.max_hr)} bpm` : null);
  stat("Calories", a.calories ? `${Math.round(a.calories)} kcal` : null);
  stat("Elevation gain", a.elevation_gain > 0 ? `${Math.round(a.elevation_gain)} m` : null);
  stat("Elevation loss", a.elevation_loss > 0 ? `${Math.round(a.elevation_loss)} m` : null);
  stat("Avg power", a.avg_power > 0 ? `${Math.round(a.avg_power)} W` : null);
  stat("Max power", a.max_power > 0 ? `${Math.round(a.max_power)} W` : null);
  stat("Normalized power", a.norm_power > 0 ? `${Math.round(a.norm_power)} W` : null);
  stat("TSS", a.training_stress_score);
  stat("Intensity factor", a.intensity_factor ? round(a.intensity_factor, 2) : null);
  stat("Aerobic TE", a.aerobic_training_effect ? round(a.aerobic_training_effect, 1) : null);
  stat("Anaerobic TE", a.anaerobic_training_effect ? round(a.anaerobic_training_effect, 1) : null);
  stat("Training load", a.training_load ? round(a.training_load, 1) : null);
  stat("VO2max", a.vo2max_value ? round(a.vo2max_value, 1) : null);
  stat("Avg cadence", a.avg_cadence > 0 ? `${Math.round(a.avg_cadence)} ${isRunning ? "spm" : "rpm"}` : null);
  stat("Avg respiration", a.avg_respiration ? round(a.avg_respiration, 1) : null);

  if (data.hr_zones) {
    const z = data.hr_zones;
    lines.push("", "## HR Zones");
    lines.push(`| Zone | Time |`);
    lines.push(`|------|------|`);
    [["Z1", z.zone1_seconds], ["Z2", z.zone2_seconds], ["Z3", z.zone3_seconds],
     ["Z4", z.zone4_seconds], ["Z5", z.zone5_seconds]].forEach(([label, secs]) => {
      if ((secs as number) > 0) lines.push(`| ${label} | ${formatDuration(secs as number)} |`);
    });
  }

  if (data.splits.length > 1) {
    lines.push("", "## Splits");
    lines.push(`| # | Distance | ${isRunning ? "Pace" : "Duration"} | Avg HR | Elev |`);
    lines.push(`|---|----------|${isRunning ? "------" : "--------"}|--------|------|`);
    for (const s of data.splits) {
      const dist = s.distance_meters ? `${round(metersToMiles(s.distance_meters), 2)} mi` : "--";
      const time = isRunning && s.average_speed ? formatPace(s.average_speed) : formatDuration(s.duration_seconds);
      const hr = s.average_hr ? `${Math.round(s.average_hr)}` : "--";
      const elev = s.elevation_gain ? `+${Math.round(s.elevation_gain)}m` : "--";
      lines.push(`| ${s.split_number} | ${dist} | ${time} | ${hr} | ${elev} |`);
    }
  }

  if (data.exercise_sets.length > 0) {
    lines.push("", "## Exercise Sets");
    lines.push(`| # | Exercise | Reps | Weight | Duration |`);
    lines.push(`|---|----------|------|--------|----------|`);
    for (const s of data.exercise_sets) {
      const name = s.exercise_name || s.exercise_category || "--";
      const reps = s.reps ?? "--";
      const weight = s.weight ? `${s.weight} kg` : "--";
      const dur = s.duration_seconds ? formatDuration(s.duration_seconds) : "--";
      lines.push(`| ${s.set_number} | ${name} | ${reps} | ${weight} | ${dur} |`);
    }
  }

  if (data.weather?.temperature != null) {
    lines.push("", "## Weather");
    stat("Temp", `${Math.round(data.weather.temperature)}°F`);
    if (data.weather.apparent_temperature != null)
      stat("Feels like", `${Math.round(data.weather.apparent_temperature)}°F`);
    if (data.weather.humidity != null) stat("Humidity", `${Math.round(data.weather.humidity)}%`);
    if (data.weather.wind_speed != null) stat("Wind", `${round(data.weather.wind_speed, 1)} m/s`);
    if (data.weather.weather_type) stat("Conditions", data.weather.weather_type);
  }

  return lines.join("\n");
}

export function ActivityDetail({ id }: { id: number }) {
  const { data, loading } = useApi<ActivityData>(`/activities/${id}`);

  if (loading) return <div class="loading" style="padding:1.5rem">Loading activity detail...</div>;
  if (!data) return <div class="loading" style="padding:1.5rem">No detail available</div>;

  const a = data.activity;
  const isRunning = a.type?.includes("running");
  const hasSplits = data.splits.length > 1;

  return (
    <div style="padding:1.25rem;border-top:1px solid var(--border)">
      <CopyButtons data={data} buildMarkdown={buildMarkdown} />

      {/* Key metrics row */}
      <div style="display:flex;flex-wrap:wrap;gap:1.25rem;margin-bottom:1.25rem;justify-content:center">
        <Stat label="Duration" value={formatDuration(a.duration_seconds)} />
        {a.distance_meters > 0 && (
          <Stat label="Distance" value={round(metersToMiles(a.distance_meters), 2)} unit="mi" />
        )}
        {a.average_speed > 0 && isRunning && (
          <Stat label="Pace" value={formatPace(a.average_speed)} />
        )}
        {a.average_speed > 0 && !isRunning && a.distance_meters > 0 && (
          <Stat label="Speed" value={round(msToMph(a.average_speed), 1)} unit="mph" />
        )}
        <Stat label="Avg HR" value={a.average_hr ? Math.round(a.average_hr) : null} unit="bpm" />
        <Stat label="Max HR" value={a.max_hr ? Math.round(a.max_hr) : null} unit="bpm" />
        {a.calories > 0 && <Stat label="Calories" value={Math.round(a.calories)} unit="kcal" />}
        {a.elevation_gain > 0 && (
          <Stat label="Elev Gain" value={Math.round(a.elevation_gain)} unit="m" />
        )}
        {a.avg_power > 0 && <Stat label="Avg Power" value={Math.round(a.avg_power)} unit="W" />}
        {a.norm_power > 0 && <Stat label="NP" value={Math.round(a.norm_power)} unit="W" />}
        {a.avg_cadence > 0 && (
          <Stat label="Cadence" value={Math.round(a.avg_cadence)} unit={isRunning ? "spm" : "rpm"} />
        )}
        {a.training_load > 0 && <Stat label="Load" value={round(a.training_load)} />}
        {a.vo2max_value > 0 && <Stat label="VO2max" value={round(a.vo2max_value)} />}
      </div>

      {/* Training Effect */}
      {(a.aerobic_training_effect > 0 || a.anaerobic_training_effect > 0) && (
        <div style="display:flex;gap:1.5rem;margin-bottom:1.25rem">
          <TrainingEffectGauge value={a.aerobic_training_effect} label="Aerobic" color="var(--color-steps)" />
          <TrainingEffectGauge value={a.anaerobic_training_effect} label="Anaerobic" color="var(--color-stress)" />
        </div>
      )}

      {/* HR Zones */}
      {data.hr_zones && (
        <div style="margin-bottom:1.25rem">
          <HrZoneBar zones={data.hr_zones} />
        </div>
      )}

      {/* Splits table */}
      {hasSplits && (
        <div>
          <div style="font-size:0.7rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem">
            Splits
          </div>
          <table style="font-size:0.8rem">
            <thead>
              <tr>
                <th style="padding:0.375rem 0.75rem">#</th>
                <th style="padding:0.375rem 0.75rem">Distance</th>
                <th style="padding:0.375rem 0.75rem">{isRunning ? "Pace" : "Duration"}</th>
                <th style="padding:0.375rem 0.75rem">Avg HR</th>
                {data.splits.some((s) => s.elevation_gain > 0) && (
                  <th style="padding:0.375rem 0.75rem">Elev</th>
                )}
                {data.splits.some((s) => s.avg_cadence > 0) && (
                  <th style="padding:0.375rem 0.75rem">Cadence</th>
                )}
              </tr>
            </thead>
            <tbody>
              {data.splits.map((s) => (
                <tr key={s.split_number}>
                  <td style="padding:0.375rem 0.75rem">{s.split_number}</td>
                  <td style="padding:0.375rem 0.75rem">
                    {s.distance_meters ? `${round(metersToMiles(s.distance_meters), 2)} mi` : "--"}
                  </td>
                  <td style="padding:0.375rem 0.75rem">
                    {isRunning && s.average_speed
                      ? formatPace(s.average_speed)
                      : formatDuration(s.duration_seconds)}
                  </td>
                  <td style="padding:0.375rem 0.75rem">
                    {s.average_hr ? `${Math.round(s.average_hr)}` : "--"}
                  </td>
                  {data.splits.some((sp) => sp.elevation_gain > 0) && (
                    <td style="padding:0.375rem 0.75rem">
                      {s.elevation_gain ? `+${Math.round(s.elevation_gain)}m` : "--"}
                    </td>
                  )}
                  {data.splits.some((sp) => sp.avg_cadence > 0) && (
                    <td style="padding:0.375rem 0.75rem">
                      {s.avg_cadence ? Math.round(s.avg_cadence) : "--"}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Weather */}
      {data.weather?.temperature != null && (
        <div style="margin-top:1rem;display:flex;gap:1.25rem;font-size:0.8rem;color:var(--text-dim)">
          <span>Temp: {Math.round(data.weather.temperature)}°F</span>
          {data.weather.humidity != null && <span>Humidity: {Math.round(data.weather.humidity)}%</span>}
          {data.weather.wind_speed != null && <span>Wind: {round(data.weather.wind_speed, 1)} m/s</span>}
          {data.weather.weather_type && <span>{data.weather.weather_type}</span>}
        </div>
      )}
    </div>
  );
}
