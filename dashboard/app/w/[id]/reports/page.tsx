import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/supabase-server";
import { TopBar } from "@/components/topbar";
import { FilterSelect } from "@/components/filter-select";
import { BarList, DailyChart } from "@/components/charts";
import { TEAM_TZ, startOfDay, tzDate } from "@/lib/time";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types returned by public.workspace_report
// ---------------------------------------------------------------------------
type Cell = { dow: number; hour: number; pickups: number; booked: number };
type Stage = { id: string; label: string; n: number };
type Obj = { label: string; n: number };
type Rep = {
  id: string;
  name: string;
  pickups: number;
  booked: number;
  prev_pickups: number;
  prev_booked: number;
  days_active: number;
  eods: number;
  days_hit: number;
  avg_dials: number | null;
  avg_energy: number | null;
  lost_staged: number;
  stages: Record<string, number>;
  objections: Obj[];
};
type Client = {
  id: string | null;
  name: string;
  pickups: number;
  booked: number;
  prev_pickups: number;
  prev_booked: number;
  stages: Record<string, number>;
  objections: Obj[];
  best_rep: { name: string; pickups: number; booked: number } | null;
  best_hour: { hour: number; pickups: number; booked: number } | null;
};
type Report = {
  totals: {
    pickups: number;
    booked: number;
    prev_pickups: number;
    prev_booked: number;
    reps: number;
    rep_days: number;
    eods: number;
    eods_hit: number;
    lost_staged: number;
  };
  targets: { min_dials: number | null; min_booked: number | null };
  stages: Stage[];
  heatmap: Cell[];
  objections: Obj[];
  daily: { day: string; pickups: number; booked: number }[];
  reps: Rep[];
  clients: Client[];
};
type RepClient = {
  user_id: string;
  rep_name: string | null;
  client_id: string | null;
  client_name: string;
  conversations: number;
  booked: number;
  dials: number;
  top_stage: string | null;
  top_objection: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const RANGE_OPTS = [
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
  { key: "90d", label: "90 days", days: 90 },
] as const;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const rate = (b: number, n: number) => (n ? b / n : 0);
const pctTxt = (b: number, n: number) => (n ? `${Math.round((b / n) * 100)}%` : "–");
const hourTxt = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "am" : "pm"}`;
const slotTxt = (h: number) => `${hourTxt(h)}–${hourTxt((h + 1) % 24)}`;
const tzName = () =>
  new Intl.DateTimeFormat("en-US", { timeZone: TEAM_TZ, timeZoneName: "long" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value ?? TEAM_TZ;

// Change in book rate (percentage points) vs the previous period, when both have data.
// Previous period must be comparable in size, otherwise a tool that just started
// shows silly jumps like "+2000%".
const comparable = (n: number, pn: number) => n >= 20 && pn >= Math.max(20, n * 0.4);
function rateDelta(b: number, n: number, pb: number, pn: number) {
  if (!comparable(n, pn)) return null;
  return Math.round((rate(b, n) - rate(pb, pn)) * 100);
}

function Delta({ pts, suffix = " pts" }: { pts: number | null; suffix?: string }) {
  if (pts === null) return <span className="muted">—</span>;
  if (pts === 0) return <span className="delta flat">±0{suffix}</span>;
  return (
    <span className={`delta ${pts > 0 ? "up" : "down"}`}>
      {pts > 0 ? "▲" : "▼"} {Math.abs(pts)}
      {suffix}
    </span>
  );
}

// Share of a rep's (or client's) lost calls that died at each stage.
function shares(stages: Record<string, number>, total: number, ids: string[]) {
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = total ? (stages[id] ?? 0) / total : 0;
  return out;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default async function Reports({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string; client?: string; rep?: string; metric?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const range = RANGE_OPTS.find((r) => r.key === sp.range) ?? RANGE_OPTS[1];
  const clientFilter = sp.client && UUID.test(sp.client) ? sp.client : null;
  const repFilter = sp.rep && UUID.test(sp.rep) ? sp.rep : null;
  const metric = sp.metric === "rate" ? "rate" : "pickups";

  const { supabase, user } = await requireUser();
  if (!user) redirect("/login");
  const { data: ws } = await supabase.from("workspaces").select("id,name").eq("id", id).single();
  if (!ws) notFound();

  const from = startOfDay(TEAM_TZ, range.days - 1);
  const to = new Date(startOfDay(TEAM_TZ, 0).getTime() + 86_400_000);

  const [{ data, error }, { data: clientRows }, { data: memberRows }, { data: statsData }] = await Promise.all([
    supabase.rpc("workspace_report", {
      p_workspace: id,
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_tz: TEAM_TZ,
      ...(clientFilter ? { p_client: clientFilter } : {}),
      ...(repFilter ? { p_rep: repFilter } : {}),
    }),
    supabase.from("clients").select("id,name").eq("workspace_id", id).order("sort").order("name"),
    supabase
      .from("memberships")
      .select("user_id, profile:profiles(full_name,email)")
      .eq("workspace_id", id)
      .eq("active", true),
    // Rep × client table (includes dials split per client from EODs).
    supabase.rpc("workspace_stats", {
      p_workspace: id,
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_tz: TEAM_TZ,
      ...(clientFilter ? { p_client: clientFilter } : {}),
    }),
  ]);

  if (error) {
    return (
      <>
        <TopBar workspace={ws} active="reports" />
        <main className="page narrow">
          <section className="card">
            <h2>Managers only</h2>
            <p className="muted">Reports are available to managers of this team.</p>
          </section>
        </main>
      </>
    );
  }
  const r = data as Report;
  const t = r.totals;

  // Filter options
  const memberOpts = (memberRows ?? [])
    .map((m) => {
      const p = m.profile as unknown as { full_name: string | null; email: string | null } | null;
      return { value: m.user_id as string, label: p?.full_name || p?.email || "Someone" };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  const clientOpts = (clientRows ?? []).map((c) => ({ value: c.id as string, label: c.name as string }));

  const qs = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams();
    const merged: Record<string, string | null> = {
      range: range.key,
      client: clientFilter,
      rep: repFilter,
      metric: metric === "rate" ? "rate" : null,
      ...patch,
    };
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, v);
    return `?${next.toString()}`;
  };

  // -------------------------------------------------------------------------
  // When to call
  // -------------------------------------------------------------------------
  const cells = r.heatmap;
  const avgRate = rate(t.booked, t.pickups);
  const minSample = Math.max(3, Math.round(t.pickups / 80));
  const hoursPresent = cells.map((c) => c.hour);
  const hMin = hoursPresent.length ? Math.min(...hoursPresent) : 9;
  const hMax = hoursPresent.length ? Math.max(...hoursPresent) : 17;
  const hours = Array.from({ length: hMax - hMin + 1 }, (_, i) => hMin + i);
  const daysPresent = new Set(cells.map((c) => c.dow));
  const dows = [1, 2, 3, 4, 5, 6, 7].filter((d) => d <= 5 || daysPresent.has(d));
  const cellAt = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c]));
  const maxPick = Math.max(1, ...cells.map((c) => c.pickups));
  const rated = cells.filter((c) => c.pickups >= minSample);
  const maxRate = Math.max(0.01, ...rated.map((c) => rate(c.booked, c.pickups)));

  const sumBy = (key: "dow" | "hour") => {
    const m = new Map<number, { pickups: number; booked: number }>();
    for (const c of cells) {
      const v = m.get(c[key]) ?? { pickups: 0, booked: 0 };
      v.pickups += c.pickups;
      v.booked += c.booked;
      m.set(c[key], v);
    }
    return m;
  };
  const byHour = sumBy("hour");
  const byDow = sumBy("dow");
  const maxHourPick = Math.max(1, ...[...byHour.values()].map((v) => v.pickups));
  const maxDowPick = Math.max(1, ...[...byDow.values()].map((v) => v.pickups));

  const bestSlots = [...rated]
    .sort((a, b) => rate(b.booked, b.pickups) - rate(a.booked, a.pickups) || b.pickups - a.pickups)
    .slice(0, 3);
  const worstSlot = [...rated].sort(
    (a, b) => rate(a.booked, a.pickups) - rate(b.booked, b.pickups) || b.pickups - a.pickups
  )[0];
  const busiestHour = [...byHour.entries()].sort((a, b) => b[1].pickups - a[1].pickups)[0];

  // -------------------------------------------------------------------------
  // Reps
  // -------------------------------------------------------------------------
  const stageIds = r.stages.map((s) => s.id);
  const teamShare = shares(
    Object.fromEntries(r.stages.map((s) => [s.id, s.n])),
    t.lost_staged,
    stageIds
  );
  const repRows = r.reps.map((rep) => {
    const sh = shares(rep.stages, rep.lost_staged, stageIds);
    let leak: { label: string; rep: number; team: number } | null = null;
    if (rep.lost_staged >= 8) {
      for (const s of r.stages) {
        const diff = sh[s.id] - teamShare[s.id];
        if (diff >= 0.05 && (!leak || diff > leak.rep - leak.team)) {
          leak = { label: s.label, rep: sh[s.id], team: teamShare[s.id] };
        }
      }
    }
    return { rep, sh, leak };
  });
  const topStage = [...r.stages].sort((a, b) => b.n - a.n)[0];
  const repWithBiggestLeak = repRows
    .filter((x) => x.leak)
    .sort((a, b) => b.leak!.rep - b.leak!.team - (a.leak!.rep - a.leak!.team))[0];

  // -------------------------------------------------------------------------
  // Key findings (plain sentences at the top)
  // -------------------------------------------------------------------------
  const findings: React.ReactNode[] = [];
  if (bestSlots[0]) {
    const b = bestSlots[0];
    findings.push(
      <>
        Best booking window: <b>{DAYS[b.dow - 1]} {slotTxt(b.hour)}</b> books{" "}
        <b>{pctTxt(b.booked, b.pickups)}</b> of pick-ups ({b.pickups} calls) vs <b>{pctTxt(t.booked, t.pickups)}</b>{" "}
        on average.
      </>
    );
  }
  if (worstSlot && bestSlots[0] && worstSlot !== bestSlots[0]) {
    findings.push(
      <>
        Weakest window: <b>{DAYS[worstSlot.dow - 1]} {slotTxt(worstSlot.hour)}</b> at{" "}
        {pctTxt(worstSlot.booked, worstSlot.pickups)} ({worstSlot.pickups} calls). Use it for follow-ups or admin.
      </>
    );
  }
  if (topStage?.n && t.lost_staged) {
    findings.push(
      <>
        Most lost calls die at the <b>{topStage.label}</b> ({pctTxt(topStage.n, t.lost_staged)} of lost calls).
      </>
    );
  }
  if (repWithBiggestLeak?.leak) {
    const l = repWithBiggestLeak.leak;
    findings.push(
      <>
        Coaching target: <b>{repWithBiggestLeak.rep.name}</b> loses {Math.round(l.rep * 100)}% of lost calls at the{" "}
        <b>{l.label}</b> (team {Math.round(l.team * 100)}%).
      </>
    );
  }
  const bookDelta = rateDelta(t.booked, t.pickups, t.prev_booked, t.prev_pickups);
  if (bookDelta !== null) {
    findings.push(
      <>
        Book rate is <b>{pctTxt(t.booked, t.pickups)}</b>, <Delta pts={bookDelta} /> vs the previous {range.days} days.
      </>
    );
  }
  if (t.rep_days > 0) {
    const missing = Math.max(0, t.rep_days - t.eods);
    if (missing > 0) {
      findings.push(
        <>
          <b>{missing}</b> of {t.rep_days} rep-days have no end-of-day sign-off, so dials and targets are incomplete.
        </>
      );
    }
  }

  // Daily trend with empty days filled in so gaps are visible.
  const byDay = new Map((r.daily ?? []).map((d) => [d.day, d]));
  const trendDays = Array.from({ length: range.days }, (_, i) => {
    const day = tzDate(TEAM_TZ, range.days - 1 - i);
    const d = byDay.get(day);
    return { day, conversations: d?.pickups ?? 0, booked: d?.booked ?? 0 };
  });
  const lostTotal = t.lost_staged;
  const objectionTotal = r.objections.reduce((a, o) => a + o.n, 0);
  const repClients = ((statsData as { rep_clients?: RepClient[] } | null)?.rep_clients ?? []).filter(
    (rc) => !repFilter || rc.user_id === repFilter
  );

  const thin = t.pickups < 100;
  const zone = tzName();

  return (
    <>
      <TopBar workspace={ws} active="reports">
        <nav className="range" aria-label="Time range">
          {RANGE_OPTS.map((o) => (
            <Link key={o.key} href={qs({ range: o.key })} className={o.key === range.key ? "on" : ""}>
              {o.label}
            </Link>
          ))}
        </nav>
      </TopBar>

      <main className="page reports">
        <div className="report-head">
          <div>
            <h1 className="page-title">Reports</h1>
            <p className="muted small">
              Last {range.days} days · times in {zone} · compared with the {range.days} days before
            </p>
          </div>
          <div className="filters">
            {clientOpts.length > 0 && (
              <FilterSelect
                param="client"
                label="Client"
                value={clientFilter ?? ""}
                options={[{ value: "", label: "All clients" }, ...clientOpts]}
              />
            )}
            <FilterSelect
              param="rep"
              label="Rep"
              value={repFilter ?? ""}
              options={[{ value: "", label: "All reps" }, ...memberOpts]}
            />
          </div>
        </div>

        {/* KPIs */}
        <section className="kpis report-kpis">
          <div className="kpi">
            <span>Pick-ups</span>
            <b>{t.pickups.toLocaleString()}</b>
            <Delta
              pts={comparable(t.pickups, t.prev_pickups) ? Math.round(((t.pickups - t.prev_pickups) / t.prev_pickups) * 100) : null}
              suffix="%"
            />
          </div>
          <div className="kpi good">
            <span>Booked</span>
            <b>{t.booked}</b>
            <Delta
              pts={comparable(t.pickups, t.prev_pickups) && t.prev_booked ? Math.round(((t.booked - t.prev_booked) / t.prev_booked) * 100) : null}
              suffix="%"
            />
          </div>
          <div className="kpi">
            <span>Book rate</span>
            <b>{pctTxt(t.booked, t.pickups)}</b>
            <Delta pts={bookDelta} />
          </div>
          <div className="kpi">
            <span>Days on target</span>
            <b>
              {t.eods ? pctTxt(t.eods_hit, t.eods) : "–"}
              {t.eods > 0 && <small> of {t.eods}</small>}
            </b>
          </div>
          <div className="kpi">
            <span>EOD sign-offs</span>
            <b>
              {t.rep_days ? pctTxt(Math.min(t.eods, t.rep_days), t.rep_days) : "–"}
              {t.rep_days > 0 && <small> of {t.rep_days} days</small>}
            </b>
          </div>
        </section>

        {t.pickups === 0 ? (
          <section className="card">
            <p className="muted empty">No calls logged in this period with these filters.</p>
          </section>
        ) : (
          <>
            {findings.length > 0 && (
              <section className="card findings">
                <h2>Key findings</h2>
                <ul>
                  {findings.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
                {thin && (
                  <p className="muted small">
                    Based on {t.pickups} pick-ups. Patterns become reliable after a few hundred; treat these as early
                    signals.
                  </p>
                )}
              </section>
            )}

            {/* Trend */}
            <section className="card">
              <h2>Daily trend</h2>
              <DailyChart days={trendDays} />
            </section>

            {/* Where calls die + objections */}
            <div className="grid-2">
              <section className="card">
                <h2>Where calls die</h2>
                <p className="muted small">Share of lost calls ({lostTotal}) by the stage they ended at.</p>
                <BarList items={r.stages} total={lostTotal} empty="No stages logged in this period." />
              </section>
              <section className="card">
                <h2>Top objections</h2>
                <p className="muted small">How often each objection came up.</p>
                <BarList
                  items={r.objections.map((o) => ({ id: o.label, ...o }))}
                  total={objectionTotal}
                  empty="No objections logged in this period."
                  unit="times"
                />
              </section>
            </div>

            {/* When to call */}
            <section className="card">
              <div className="card-head">
                <div>
                  <h2>When calls get picked up and booked</h2>
                  <p className="muted small">
                    Each square is one hour on one weekday.{" "}
                    {metric === "rate"
                      ? `Darker = higher book rate. Squares with fewer than ${minSample} pick-ups are left blank.`
                      : "Darker = more pick-ups. Hover a square for its book rate."}
                  </p>
                </div>
                <nav className="range small-toggle" aria-label="Heatmap metric">
                  <Link href={qs({ metric: null })} className={metric === "pickups" ? "on" : ""}>
                    Pick-ups
                  </Link>
                  <Link href={qs({ metric: "rate" })} className={metric === "rate" ? "on" : ""}>
                    Book rate
                  </Link>
                </nav>
              </div>

              <div className="heat-wrap">
                <table className="heat" aria-label="Pick-ups and bookings by weekday and hour">
                  <thead>
                    <tr>
                      <th />
                      {hours.map((h) => (
                        <th key={h} scope="col">
                          {hourTxt(h)}
                        </th>
                      ))}
                      <th scope="col" className="heat-total">
                        Day
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {dows.map((d) => {
                      const day = byDow.get(d);
                      return (
                        <tr key={d}>
                          <th scope="row">{DAYS[d - 1]}</th>
                          {hours.map((h) => {
                            const c = cellAt.get(`${d}-${h}`);
                            const n = c?.pickups ?? 0;
                            const b = c?.booked ?? 0;
                            const enough = n >= minSample;
                            const v = metric === "rate" ? (enough ? rate(b, n) / maxRate : -1) : n / maxPick;
                            const title = n
                              ? `${DAYS[d - 1]} ${slotTxt(h)}: ${n} pick-ups, ${b} booked (${pctTxt(b, n)})`
                              : `${DAYS[d - 1]} ${slotTxt(h)}: no pick-ups`;
                            return (
                              <td
                                key={h}
                                title={title}
                                className={`${v < 0 ? "na" : ""} ${v > 0.55 ? "strong" : ""}`}
                                style={v > 0 ? ({ "--v": v.toFixed(3) } as React.CSSProperties) : undefined}
                              >
                                {n === 0
                                  ? ""
                                  : metric === "rate"
                                    ? enough
                                      ? `${Math.round(rate(b, n) * 100)}`
                                      : "·"
                                    : n}
                              </td>
                            );
                          })}
                          <td className="heat-total" title={day ? `${day.booked} booked` : ""}>
                            {day ? (metric === "rate" ? pctTxt(day.booked, day.pickups) : day.pickups) : ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="grid-2 align-start mt">
                <div>
                  <h3 className="h3">Best times to book</h3>
                  {bestSlots.length === 0 ? (
                    <p className="muted small">Not enough calls per hour yet.</p>
                  ) : (
                    <ol className="best-list">
                      {bestSlots.map((c) => (
                        <li key={`${c.dow}-${c.hour}`}>
                          <b>
                            {DAYS[c.dow - 1]} {slotTxt(c.hour)}
                          </b>
                          <span className="good-text">{pctTxt(c.booked, c.pickups)} book rate</span>
                          <span className="muted">
                            {c.booked} of {c.pickups}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                  {busiestHour && (
                    <p className="muted small">
                      Busiest hour for pick-ups: {slotTxt(busiestHour[0])} ({busiestHour[1].pickups}). Average book
                      rate {pctTxt(t.booked, t.pickups)}.
                    </p>
                  )}
                </div>
                <div>
                  <h3 className="h3">By hour</h3>
                  <table className="table compact mini">
                    <thead>
                      <tr>
                        <th>Hour</th>
                        <th>Pick-ups</th>
                        <th className="num">Booked</th>
                        <th className="num">Book rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hours.map((h) => {
                        const v = byHour.get(h) ?? { pickups: 0, booked: 0 };
                        const better = v.pickups >= minSample * 3 && rate(v.booked, v.pickups) >= avgRate * 1.2;
                        return (
                          <tr key={h}>
                            <td>{slotTxt(h)}</td>
                            <td>
                              <span className="inline-bar">
                                <i style={{ width: `${(v.pickups / maxHourPick) * 100}%` }} />
                              </span>
                              {v.pickups}
                            </td>
                            <td className="num">{v.booked}</td>
                            <td className={`num ${better ? "good-text strong-num" : ""}`}>
                              {pctTxt(v.booked, v.pickups)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <h3 className="h3 mt">By day</h3>
                  <table className="table compact mini">
                    <tbody>
                      {dows.map((d) => {
                        const v = byDow.get(d) ?? { pickups: 0, booked: 0 };
                        return (
                          <tr key={d}>
                            <td>{DAYS[d - 1]}</td>
                            <td>
                              <span className="inline-bar">
                                <i style={{ width: `${(v.pickups / maxDowPick) * 100}%` }} />
                              </span>
                              {v.pickups}
                            </td>
                            <td className="num">{v.booked}</td>
                            <td className="num">{pctTxt(v.booked, v.pickups)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            {/* Reps */}
            <section className="card">
              <h2>Rep scorecard</h2>
              <p className="muted small">
                Trend = change in book rate vs the previous {range.days} days. Biggest leak = the stage where the rep
                loses a bigger share of calls than the team.
              </p>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Rep</th>
                      <th className="num">Pick-ups</th>
                      <th className="num">Booked</th>
                      <th className="num">Book rate</th>
                      <th className="num">Trend</th>
                      <th className="num">Avg dials/day</th>
                      <th className="num">On target</th>
                      <th className="num">EODs done</th>
                      <th>Biggest leak</th>
                      <th>Top objection</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repRows.map(({ rep, leak }) => (
                      <tr key={rep.id}>
                        <td>
                          <Link href={qs({ rep: rep.id })} className="row-link" title="Filter the report to this rep">
                            <b>{rep.name}</b>
                          </Link>
                        </td>
                        <td className="num">{rep.pickups}</td>
                        <td className="num good-text">{rep.booked}</td>
                        <td className="num">{pctTxt(rep.booked, rep.pickups)}</td>
                        <td className="num">
                          <Delta pts={rateDelta(rep.booked, rep.pickups, rep.prev_booked, rep.prev_pickups)} />
                        </td>
                        <td className="num">{rep.avg_dials ?? "—"}</td>
                        <td className="num">{rep.eods ? `${rep.days_hit}/${rep.eods}` : "—"}</td>
                        <td className="num">
                          <span className={rep.days_active && rep.eods < rep.days_active ? "bad-text" : ""}>
                            {rep.eods}/{rep.days_active || rep.eods}
                          </span>
                        </td>
                        <td>
                          {leak ? (
                            <span className="leak-txt">
                              {leak.label} <b>{Math.round(leak.rep * 100)}%</b>{" "}
                              <span className="muted">(team {Math.round(leak.team * 100)}%)</span>
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          {rep.objections[0] ? (
                            <>
                              {rep.objections[0].label} <span className="muted">({rep.objections[0].n})</span>
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h3 className="h3 mt">Where each rep loses calls</h3>
              <p className="muted small">
                Share of each rep&apos;s lost calls by the stage they died at. Highlighted = 10+ points worse than the
                team.
              </p>
              <div className="table-wrap">
                <table className="table compact leak-matrix">
                  <thead>
                    <tr>
                      <th>Rep</th>
                      {r.stages.map((s) => (
                        <th key={s.id} className="num">
                          {s.label}
                        </th>
                      ))}
                      <th className="num">Lost calls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repRows.map(({ rep, sh }) => (
                      <tr key={rep.id}>
                        <td>{rep.name}</td>
                        {r.stages.map((s) => {
                          const diff = sh[s.id] - teamShare[s.id];
                          const bad = rep.lost_staged >= 8 && diff >= 0.1;
                          return (
                            <td
                              key={s.id}
                              className={`num ${bad ? "leak" : ""}`}
                              title={`${rep.name}: ${rep.stages[s.id] ?? 0} of ${rep.lost_staged} lost calls died at ${s.label}`}
                            >
                              {rep.lost_staged ? `${Math.round(sh[s.id] * 100)}%` : "—"}
                              {bad && <span aria-label="worse than team"> ▲</span>}
                            </td>
                          );
                        })}
                        <td className="num muted">{rep.lost_staged}</td>
                      </tr>
                    ))}
                    <tr className="team-row">
                      <td>
                        <b>Team</b>
                      </td>
                      {r.stages.map((s) => (
                        <td key={s.id} className="num">
                          <b>{t.lost_staged ? `${Math.round(teamShare[s.id] * 100)}%` : "—"}</b>
                        </td>
                      ))}
                      <td className="num muted">{t.lost_staged}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            {/* Clients */}
            {r.clients.length > 0 && (
              <section className="card">
                <h2>Client results</h2>
                <p className="muted small">
                  How far calls get for each client, from pick-up to booked. Click a client to filter the whole
                  report.
                </p>
                <div className="client-grid">
                  {r.clients.map((c) => {
                    // Funnel = booked calls + lost calls whose stage was logged, so every
                    // drop between steps is exactly the calls lost at that stage.
                    const lostStaged = Object.values(c.stages).reduce((a, b) => a + b, 0);
                    const base = c.booked + lostStaged;
                    const unstaged = Math.max(0, c.pickups - base);
                    const steps: { label: string; n: number }[] = [{ label: "Picked up", n: base }];
                    let remaining = base;
                    for (const s of r.stages.slice(0, -1)) {
                      remaining -= c.stages[s.id] ?? 0;
                      steps.push({ label: `Past ${s.label.toLowerCase()}`, n: Math.max(0, remaining) });
                    }
                    steps.push({ label: "Booked", n: c.booked });
                    const d = rateDelta(c.booked, c.pickups, c.prev_booked, c.prev_pickups);
                    const biggestDrop = steps
                      .slice(1)
                      .map((s, i) => ({ label: s.label, drop: steps[i].n - s.n, from: steps[i].label }))
                      .sort((a, b) => b.drop - a.drop)[0];
                    return (
                      <article key={c.id ?? "none"} className="client-card">
                        <header>
                          {c.id ? (
                            <Link href={qs({ client: c.id })} className="row-link">
                              <h3>{c.name}</h3>
                            </Link>
                          ) : (
                            <h3 className="muted">{c.name}</h3>
                          )}
                          <div className="client-kpi">
                            <b>{pctTxt(c.booked, c.pickups)}</b> book rate <Delta pts={d} />
                          </div>
                        </header>
                        {c.pickups === 0 ? (
                          <p className="muted small">No calls in this period.</p>
                        ) : (
                          <>
                            <ul className="funnel">
                              {steps.map((s, i) => (
                                <li key={s.label} className={i === steps.length - 1 ? "last" : ""}>
                                  <span className="f-label">{s.label}</span>
                                  <span className="f-track">
                                    <i style={{ width: `${(s.n / Math.max(1, base)) * 100}%` }} />
                                  </span>
                                  <span className="f-val">
                                    {s.n} <em>{pctTxt(s.n, base)}</em>
                                  </span>
                                </li>
                              ))}
                            </ul>
                            {unstaged > 0 && (
                              <p className="muted small funnel-note">
                                {unstaged} other lost call{unstaged > 1 ? "s" : ""} had no stage logged and {unstaged > 1 ? "aren't" : "isn't"} in the funnel.
                              </p>
                            )}
                            <dl className="client-facts">
                              {biggestDrop && biggestDrop.drop > 0 && (
                                <>
                                  <dt>Biggest drop</dt>
                                  <dd>
                                    {biggestDrop.from} → {biggestDrop.label.toLowerCase()} (−{biggestDrop.drop})
                                  </dd>
                                </>
                              )}
                              <dt>Best rep</dt>
                              <dd>
                                {c.best_rep ? (
                                  <>
                                    {c.best_rep.name}{" "}
                                    <span className="muted">
                                      {pctTxt(c.best_rep.booked, c.best_rep.pickups)} of {c.best_rep.pickups}
                                    </span>
                                  </>
                                ) : (
                                  <span className="muted">Needs 5+ calls per rep</span>
                                )}
                              </dd>
                              <dt>Best hour</dt>
                              <dd>
                                {c.best_hour ? (
                                  <>
                                    {slotTxt(c.best_hour.hour)}{" "}
                                    <span className="muted">
                                      {pctTxt(c.best_hour.booked, c.best_hour.pickups)} of {c.best_hour.pickups}
                                    </span>
                                  </>
                                ) : (
                                  <span className="muted">Not enough calls yet</span>
                                )}
                              </dd>
                              <dt>Top objections</dt>
                              <dd>
                                {c.objections.length
                                  ? c.objections.map((o) => `${o.label} (${o.n})`).join(" · ")
                                  : <span className="muted">—</span>}
                              </dd>
                            </dl>
                          </>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Rep x client */}
            {clientOpts.length > 0 && repClients.length > 0 && (
              <section className="card">
                <h2>Rep × client</h2>
                <p className="muted small">How each rep performs for each client they called for.</p>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Rep</th>
                        <th>Client</th>
                        <th className="num">Dials</th>
                        <th className="num">Pick-ups</th>
                        <th className="num">Booked</th>
                        <th className="num">Book rate</th>
                        <th>Most died at</th>
                        <th>Top objection</th>
                      </tr>
                    </thead>
                    <tbody>
                      {repClients.map((rc, i) => {
                        const first = i === 0 || repClients[i - 1].user_id !== rc.user_id;
                        return (
                          <tr key={`${rc.user_id}-${rc.client_id ?? "none"}`} className={first ? "group-start" : ""}>
                            <td>{first ? <b>{rc.rep_name || "Someone"}</b> : ""}</td>
                            <td className={rc.client_id ? "" : "muted"}>{rc.client_name}</td>
                            <td className="num">{rc.dials ? rc.dials.toLocaleString() : "—"}</td>
                            <td className="num">{rc.conversations}</td>
                            <td className="num good-text">{rc.booked}</td>
                            <td className="num">{pctTxt(rc.booked, rc.conversations)}</td>
                            <td>{rc.top_stage ?? <span className="muted">—</span>}</td>
                            <td>{rc.top_objection ?? <span className="muted">—</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </>
  );
}
