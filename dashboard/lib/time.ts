export const TEAM_TZ = process.env.NEXT_PUBLIC_TEAM_TZ || "America/New_York";

export type RangeKey = "today" | "7d" | "30d";
export const RANGES: { key: RangeKey; label: string; days: number }[] = [
  { key: "today", label: "Today", days: 1 },
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
];

// Offset (ms) between the given timezone and UTC right now.
function tzOffsetMs(tz: string, at = new Date()) {
  const inTz = new Date(at.toLocaleString("en-US", { timeZone: tz }));
  const inUtc = new Date(at.toLocaleString("en-US", { timeZone: "UTC" }));
  return inTz.getTime() - inUtc.getTime();
}

// Calendar date (YYYY-MM-DD) in the team's timezone, `daysAgo` days back.
export function tzDate(tz: string, daysAgo = 0) {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
}

// Midnight (as a UTC instant) at the start of the day `daysAgo` days back in tz.
export function startOfDay(tz: string, daysAgo = 0) {
  const [y, m, d] = tzDate(tz, daysAgo).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - tzOffsetMs(tz));
}

export function rangeWindow(key: RangeKey, tz = TEAM_TZ) {
  const days = RANGES.find((r) => r.key === key)?.days ?? 1;
  return {
    from: startOfDay(tz, days - 1),
    to: new Date(startOfDay(tz, 0).getTime() + 86_400_000),
    fromDay: tzDate(tz, days - 1),
    days,
  };
}

export function relativeTime(iso: string | null) {
  if (!iso) return "—";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function pct(n: number, d: number) {
  return d ? `${Math.round((n / d) * 100)}%` : "–";
}
