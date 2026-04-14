import { useApi } from "../lib/hooks";
import { formatDuration, formatPace, metersToMiles, msToMph, round } from "../lib/format";

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
    { label: "Z1", seconds: zones.zone1_seconds, color: "#94a3b8" },
    { label: "Z2", seconds: zones.zone2_seconds, color: "#3b82f6" },
    { label: "Z3", seconds: zones.zone3_seconds, color: "#22c55e" },
    { label: "Z4", seconds: zones.zone4_seconds, color: "#f59e0b" },
    { label: "Z5", seconds: zones.zone5_seconds, color: "#ef4444" },
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

export function ActivityDetail({ id }: { id: number }) {
  const { data, loading } = useApi<ActivityData>(`/activities/${id}`);

  if (loading) return <div class="loading" style="padding:1.5rem">Loading activity detail...</div>;
  if (!data) return <div class="loading" style="padding:1.5rem">No detail available</div>;

  const a = data.activity;
  const isRunning = a.type?.includes("running");
  const hasSplits = data.splits.length > 1;

  return (
    <div style="padding:1.25rem;border-top:1px solid var(--border)">
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
          <span>Temp: {Math.round(data.weather.temperature)}°C</span>
          {data.weather.humidity != null && <span>Humidity: {Math.round(data.weather.humidity)}%</span>}
          {data.weather.wind_speed != null && <span>Wind: {round(data.weather.wind_speed, 1)} m/s</span>}
          {data.weather.weather_type && <span>{data.weather.weather_type}</span>}
        </div>
      )}
    </div>
  );
}
