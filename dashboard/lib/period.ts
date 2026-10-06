// Date periods for Reports and My stats: quick presets or any custom from → to range.
// Days are calendar days in the team timezone; `to` is exclusive (start of the day after).
import { TEAM_TZ, tzDate } from "@/lib/time";

export const PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this-week", label: "This week" },
  { key: "last-week", label: "Last week" },
  { key: "this-month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
] as const;
export type PresetKey = (typeof PRESETS)[number]["key"];

export type Period = {
  key: PresetKey | "custom";
  fromDay: string; // YYYY-MM-DD, inclusive
  toDay: string; // YYYY-MM-DD, inclusive
  from: Date; // start of fromDay in team tz
  to: Date; // start of the day after toDay in team tz
  days: number;
  label: string; // "Last 30 days", "Sep 1 – Sep 30"
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;

export function addDays(day: string, n: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}
export function dayList(fromDay: string, toDay: string) {
  const n = daysBetween(fromDay, toDay);
  return Array.from({ length: n + 1 }, (_, i) => addDays(fromDay, i));
}

// Midnight of a calendar day in a timezone, as a UTC instant (DST-safe).
export function startOfDate(day: string, tz = TEAM_TZ) {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const offset = (at: number) => {
    const t = new Date(at);
    return (
      new Date(t.toLocaleString("en-US", { timeZone: tz })).getTime() -
      new Date(t.toLocaleString("en-US", { timeZone: "UTC" })).getTime()
    );
  };
  const first = guess - offset(guess);
  return new Date(guess - offset(first));
}

const fmt = (day: string, withYear = false) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });

export function rangeLabel(fromDay: string, toDay: string) {
  const year = fromDay.slice(0, 4) !== toDay.slice(0, 4) || fromDay.slice(0, 4) !== tzDate(TEAM_TZ).slice(0, 4);
  return fromDay === toDay ? fmt(fromDay, year) : `${fmt(fromDay, year)} – ${fmt(toDay, year)}`;
}

function presetDays(key: PresetKey, today: string): [string, string] {
  const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (key) {
    case "today":
      return [today, today];
    case "yesterday":
      return [addDays(today, -1), addDays(today, -1)];
    case "this-week":
      return [addDays(today, -dow), today];
    case "last-week":
      return [addDays(today, -dow - 7), addDays(today, -dow - 1)];
    case "this-month":
      return [monthStart, today];
    case "last-month": {
      const lastEnd = addDays(monthStart, -1);
      return [`${lastEnd.slice(0, 7)}-01`, lastEnd];
    }
    case "7d":
      return [addDays(today, -6), today];
    case "30d":
      return [addDays(today, -29), today];
    case "90d":
      return [addDays(today, -89), today];
  }
}

export function resolvePeriod(
  sp: { range?: string; from?: string; to?: string },
  fallback: PresetKey
): Period {
  const today = tzDate(TEAM_TZ);
  let key: Period["key"];
  let fromDay: string;
  let toDay: string;

  if (sp.from && DAY.test(sp.from)) {
    key = "custom";
    fromDay = sp.from;
    toDay = sp.to && DAY.test(sp.to) ? sp.to : today;
    if (toDay > today) toDay = today;
    if (fromDay > toDay) [fromDay, toDay] = [toDay, fromDay];
    if (daysBetween(fromDay, toDay) >= MAX_DAYS) fromDay = addDays(toDay, -(MAX_DAYS - 1));
  } else {
    key = (PRESETS.find((p) => p.key === sp.range)?.key ?? fallback) as PresetKey;
    [fromDay, toDay] = presetDays(key, today);
  }

  const days = daysBetween(fromDay, toDay) + 1;
  const preset = PRESETS.find((p) => p.key === key);
  return {
    key,
    fromDay,
    toDay,
    from: startOfDate(fromDay),
    to: startOfDate(addDays(toDay, 1)),
    days,
    label: preset ? preset.label : rangeLabel(fromDay, toDay),
  };
}

// "the 30 days before", "the day before", "the previous 9 days"
export function prevLabel(p: Period) {
  if (p.days === 1) return "the day before";
  if (p.key === "this-week" || p.key === "last-week") return "the week before";
  if (p.key === "this-month" || p.key === "last-month") return `the ${p.days} days before`;
  return `the ${p.days} days before`;
}
