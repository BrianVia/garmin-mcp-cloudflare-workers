import { useState } from "preact/hooks";
import { useApi } from "../lib/hooks";
import { useQueryState } from "../lib/useQueryState";
import { formatDate, formatDistanceKm, formatDuration, formatPace, kmToMiles, round } from "../lib/format";
import { MetricCard } from "../components/MetricCard";
import { ActivityDetail } from "../components/ActivityDetail";

interface Activity {
  id: number;
  name: string;
  type: string;
  date: string;
  duration_min: number;
  distance_km: number;
  calories: number;
  avg_hr: number;
  max_hr: number;
  elevation_gain_m: number;
  avg_power_w: number;
  training_load: number;
  aerobic_te: number;
  location: string;
}

interface ActivityType {
  type: string;
  count: number;
}

export function Activities() {
  const [typeFilter, setTypeFilter] = useQueryState("type", "");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const { data: types } = useApi<ActivityType[]>("/activities/types");
  const { data, loading } = useApi<Activity[]>("/activities", {
    limit: "50",
    ...(typeFilter ? { type: typeFilter } : {}),
  });

  const totalActivities = data?.length ?? 0;
  const totalDuration = data?.reduce((s, a) => s + (a.duration_min || 0), 0) ?? 0;
  const totalDistanceMi = data?.reduce((s, a) => s + kmToMiles(a.distance_km || 0), 0) ?? 0;
  const totalCalories = data?.reduce((s, a) => s + (a.calories || 0), 0) ?? 0;

  return (
    <div>
      <div class="page-header">
        <div class="eyebrow">Field Notes</div>
        <h1>
          The <em>ledger</em>
        </h1>
        <div class="dateline" style="margin-top:1rem">
          <select
            value={typeFilter}
            onChange={(e) => { setTypeFilter((e.target as HTMLSelectElement).value); setExpandedId(null); }}
          >
            <option value="">All types</option>
            {types?.map((t) => (
              <option key={t.type} value={t.type}>{t.type} ({t.count})</option>
            ))}
          </select>
          <span class="sep">/</span>
          <span class="accent">Click a row for detail</span>
        </div>
      </div>

      {data && data.length > 0 && (
        <div class="cards">
          <MetricCard label="Activities" value={totalActivities} color="var(--accent)" />
          <MetricCard label="Total Time" value={formatDuration(totalDuration * 60)} color="var(--color-sleep)" />
          <MetricCard label="Total Distance" value={`${round(totalDistanceMi, 1)}`} unit="mi" color="var(--color-steps)" />
          <MetricCard label="Total Calories" value={totalCalories.toLocaleString()} unit="kcal" color="var(--color-stress)" />
        </div>
      )}

      {loading ? (
        <div class="loading">Loading...</div>
      ) : (
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
                <th>Elevation</th>
                <th>Load</th>
                <th>TE</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((a) => (
                <>
                  <tr
                    key={a.id}
                    onClick={() => setExpandedId(expandedId === a.id ? null : a.id)}
                    style="cursor:pointer"
                  >
                    <td>{formatDate(a.date?.slice(0, 10) ?? "")}</td>
                    <td>{a.name}</td>
                    <td><span class="badge badge-blue">{a.type}</span></td>
                    <td>{a.duration_min ? formatDuration(a.duration_min * 60) : "--"}</td>
                    <td>{a.distance_km ? formatDistanceKm(a.distance_km) : "--"}</td>
                    <td>{a.avg_hr ? `${Math.round(a.avg_hr)}` : "--"}</td>
                    <td>{a.elevation_gain_m ? `${Math.round(a.elevation_gain_m)}m` : "--"}</td>
                    <td>{a.training_load ?? "--"}</td>
                    <td>{a.aerobic_te ?? "--"}</td>
                  </tr>
                  {expandedId === a.id && (
                    <tr key={`${a.id}-detail`}>
                      <td colspan={9} style="padding:0;background:var(--bg-card)">
                        <ActivityDetail id={a.id} />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
