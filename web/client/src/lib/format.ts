export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const KM_PER_MILE = 1.609344;
const M_PER_MILE = 1609.344;
const MS_TO_MPH = 2.2369362920544;

export function kmToMiles(km: number): number {
  return km / KM_PER_MILE;
}

export function metersToMiles(m: number): number {
  return m / M_PER_MILE;
}

export function formatDistanceKm(km: number | null | undefined, decimals = 2): string {
  if (km == null || !isFinite(km)) return "--";
  return `${kmToMiles(km).toFixed(decimals)} mi`;
}

export function formatDistanceMeters(m: number | null | undefined, decimals = 2): string {
  if (m == null || !isFinite(m)) return "--";
  return `${metersToMiles(m).toFixed(decimals)} mi`;
}

export function msToMph(speedMs: number): number {
  return speedMs * MS_TO_MPH;
}

export function formatSpeed(speedMs: number | null | undefined, decimals = 1): string {
  if (speedMs == null || speedMs <= 0) return "--";
  return `${msToMph(speedMs).toFixed(decimals)} mph`;
}

export function formatPace(speedMs: number): string {
  if (!speedMs || speedMs <= 0) return "--";
  const paceSeconds = M_PER_MILE / speedMs;
  const m = Math.floor(paceSeconds / 60);
  const s = Math.floor(paceSeconds % 60);
  return `${m}:${String(s).padStart(2, "0")}/mi`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatDateFull(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function round(n: number | null | undefined, decimals = 1): string {
  if (n == null) return "--";
  return n.toFixed(decimals);
}

export function formatMinutes(min: number | null | undefined): string {
  if (min == null) return "--";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}
