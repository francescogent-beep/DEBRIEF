import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/supabase-server";
import { TopBar } from "@/components/topbar";
import { FilterSelect } from "@/components/filter-select";
import { PeriodPicker } from "@/components/period-picker";
import { TEAM_TZ, tzDate } from "@/lib/time";
import { PRESETS, resolvePeriod, rangeLabel } from "@/lib/period";

export const dynamic = "force-dynamic";

// A rep's own page: where they're at today, how they compare with the team
// average, what to work on, a day-by-day review and every call they logged.

type Mine = {
  pickups: number;
  booked: number;
  prev_pickups: number;
  prev_booked: number;
  days_active: number;
  eods: number;
  days_hit: number;
  avg_dials: number | null;
  lost_staged: number;
  stages: Record<string, number>;
  objections: { label: string; n: number }[];
  hours: { hour: number; pickups: number; booked: number }[];
  gap_median: number | null;
  daily: {
    day: string;
    pickups: number;
    booked: number;
    dials: number | null;
    energy: number | null;
    went_well: string | null;
    improve: string | null;
    blockers: string | null;
    signed_off: boolean;
    on_target: boolean | null;
  }[];
};
type Team = {
  reps: number;
  rep_days: number;
  pickups: number;
  booked: number;
  eods: number;
  days_hit: number;
  avg_dials: number | null;
  lost_staged: number;
  stages: Record<string, number>;
  gap_median: number | null;
};
type RepReport = {
  targets: { min_dials: number | null; min_booked: number | null };
  stages: { id: string; label: string }[];
  today: { pickups: number; booked: number; signed_off: boolean };
  me: Mine;
  team: Team;
};

const PAGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const rate = (b: number, n: number) => (n ? b / n : 0);
const pctTxt = (b: number, n: number) => (n ? `${Math.round((b / n) * 100)}%` : "–");
const one = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const hourTxt = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "am" : "pm"}`;
const slotTxt = (h: number) => `${hourTxt(h)}–${hourTxt((h + 1) % 24)}`;
const minTxt = (m: number | null) => (m == null ? "—" : `${Math.round(m)} min`);
const fmtDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TEAM_TZ });

// Comparison chip: how the rep stands vs the team average.
function Vs({ me, team, unit = "", lowerIsBetter = false, fmt = one }: {
  me: number | null; team: number | null; unit?: string; lowerIsBetter?: boolean; fmt?: (v: number) => string;
}) {
  if (team == null) return <small className="muted">Team avg —</small>;
  if (me == null) return <small className="muted">Team avg {fmt(team)}{unit}</small>;
  const diff = me - team;
  const close = Math.abs(diff) < Math.max(0.05 * Math.abs(team), 0.01);
  const good = lowerIsBetter ? diff < 0 : diff > 0;
  return (
    <small className={close ? "muted" : good ? "good-text" : "bad-text"}>
      {close ? "≈" : diff > 0 ? "▲" : "▼"} team avg {fmt(team)}
      {unit}
    </small>
  );
}

export default async function MyStats({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string; from?: string; to?: string; outcome?: string; page?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const range = resolvePeriod(sp, "7d");
  const outcomeFilter = sp.outcome && UUID.test(sp.outcome) ? sp.outcome : null;
  const page = Math.max(1, Number(sp.page) || 1);

  const { supabase, user } = await requireUser();
  if (!user) redirect("/login");

  const [{ data: ws }, { data: membership }, { data: profile }] = await Promise.all([
    supabase.from("workspaces").select("id,name").eq("id", id).single(),
    supabase.from("memberships").select("role").eq("workspace_id", id).eq("user_id", user.id).eq("active", true).maybeSingle(),
    supabase.from("profiles").select("full_name").eq("id", user.id).single(),
  ]);
  if (!ws) notFound();
  const role = membership?.role === "rep" ? "rep" : "manager";

  const { from, to } = range;
  const periodText = range.key === "custom" ? range.label : `${range.label} (${rangeLabel(range.fromDay, range.toDay)})`;
  const inPeriod = range.key === "custom" ? `between ${range.label}` : range.label.toLowerCase();

  let calls = supabase
    .from("call_logs")
    .select("id,created_at,outcome_id,stage_id,objection_id,client_id,note", { count: "exact" })
    .eq("workspace_id", id)
    .eq("rep_id", user.id)
    .gte("created_at", from.toISOString())
    .lt("created_at", to.toISOString());
  if (outcomeFilter) calls = calls.eq("outcome_id", outcomeFilter);

  const [{ data, error }, { data: opts }, { data: clients }, { data: callRows, count }] = await Promise.all([
    supabase.rpc("rep_report", { p_workspace: id, p_from: from.toISOString(), p_to: to.toISOString(), p_tz: TEAM_TZ }),
    supabase.from("options").select("id,kind,label,is_success,sort").eq("workspace_id", id).order("sort"),
    supabase.from("clients").select("id,name").eq("workspace_id", id),
    calls.order("created_at", { ascending: false }).range((page - 1) * PAGE, page * PAGE - 1),
  ]);

  if (error || !data) {
    return (
      <>
        <TopBar workspace={ws} active="me" role={role} />
        <main className="page narrow">
          <section className="card">
            <h2>Not available</h2>
            <p className="muted">You need to be part of this team to see your stats.</p>
          </section>
        </main>
      </>
    );
  }

  const r = data as RepReport;
  const m = r.me;
  const tm = r.team;
  const labels = new Map((opts ?? []).map((o) => [o.id as string, o]));
  const clientNames = new Map((clients ?? []).map((c) => [c.id as string, c.name as string]));
  const outcomes = (opts ?? []).filter((o) => o.kind === "outcome");
  const qs = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams();
    const merged: Record<string, string | null> = {
      range: range.key === "custom" ? null : range.key,
      from: range.key === "custom" ? range.fromDay : null,
      to: range.key === "custom" ? range.toDay : null,
      outcome: outcomeFilter,
      ...patch,
    };
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, v);
    return `?${next.toString()}`;
  };

  // ---- Per-day averages (fair comparison: per day worked) -----------------
  const myDays = Math.max(1, m.days_active);
  const teamDays = Math.max(1, tm.rep_days);
  const myPick = m.days_active ? m.pickups / myDays : null;
  const teamPick = tm.rep_days ? tm.pickups / teamDays : null;
  const myBook = m.days_active ? m.booked / myDays : null;
  const teamBook = tm.rep_days ? tm.booked / teamDays : null;
  const myRate = m.pickups ? rate(m.booked, m.pickups) : null;
  const teamRate = tm.pickups ? rate(tm.booked, tm.pickups) : null;
  const myHit = m.eods ? m.days_hit / m.eods : null;
  const teamHit = tm.eods ? tm.days_hit / tm.eods : null;

  // ---- Today ---------------------------------------------------------------
  const t = r.targets;
  const today = r.today;
  const bookedGoal = t.min_booked;

  // ---- Stages: my share of lost calls vs team -------------------------------
  const stageRows = r.stages.map((s) => {
    const mine = m.lost_staged ? (m.stages[s.id] ?? 0) / m.lost_staged : 0;
    const team = tm.lost_staged ? (tm.stages[s.id] ?? 0) / tm.lost_staged : 0;
    return { ...s, n: m.stages[s.id] ?? 0, mine, team, diff: mine - team };
  });
  const leak = m.lost_staged >= 8 ? [...stageRows].filter((s) => s.diff >= 0.05).sort((a, b) => b.diff - a.diff)[0] : undefined;
  const strength = m.lost_staged >= 8 ? [...stageRows].filter((s) => s.diff <= -0.05).sort((a, b) => a.diff - b.diff)[0] : undefined;

  // ---- Hours ---------------------------------------------------------------
  const hourMin = Math.max(4, Math.round(m.pickups / 40));
  const ratedHours = m.hours.filter((h) => h.pickups >= hourMin);
  const bestHour = [...ratedHours].sort((a, b) => rate(b.booked, b.pickups) - rate(a.booked, a.pickups) || b.pickups - a.pickups)[0];
  const maxHourPick = Math.max(1, ...m.hours.map((h) => h.pickups));

  // ---- Streak of on-target days (signed-off days, newest first) -------------
  let streak = 0;
  for (const d of m.daily.filter((d) => d.signed_off)) {
    if (d.on_target) streak++;
    else break;
  }
  const todayDay = tzDate(TEAM_TZ);
  const missingEods = m.daily.filter((d) => !d.signed_off && d.pickups > 0 && d.day !== todayDay).length;

  // ---- Focus list ------------------------------------------------------------
  const focus: React.ReactNode[] = [];
  if (myRate != null && teamRate != null && m.pickups >= 15) {
    const pts = Math.round((myRate - teamRate) * 100);
    focus.push(
      pts >= 3 ? (
        <>Your book rate is <b>{Math.round(myRate * 100)}%</b>, <span className="good-text">{pts} pts above</span> the team average. Keep doing what you&apos;re doing.</>
      ) : pts <= -3 ? (
        <>Your book rate is <b>{Math.round(myRate * 100)}%</b>, <span className="bad-text">{-pts} pts below</span> the team average ({Math.round(teamRate * 100)}%).</>
      ) : (
        <>Your book rate is <b>{Math.round(myRate * 100)}%</b>, right in line with the team.</>
      )
    );
  }
  if (leak) {
    focus.push(
      <>
        <b>#1 thing to work on: the {leak.label.toLowerCase()}.</b> {Math.round(leak.mine * 100)}% of your lost calls end there,
        vs {Math.round(leak.team * 100)}% for the team.
      </>
    );
  }
  if (strength) {
    focus.push(
      <>Strong point: you lose fewer calls at the <b>{strength.label.toLowerCase()}</b> than the team ({Math.round(strength.mine * 100)}% vs {Math.round(strength.team * 100)}%).</>
    );
  }
  if (bestHour) {
    focus.push(
      <>Your best hour is <b>{slotTxt(bestHour.hour)}</b>: {pctTxt(bestHour.booked, bestHour.pickups)} book rate ({bestHour.pickups} pick-ups). Protect it for dialing.</>
    );
  }
  if (m.objections[0]) {
    focus.push(<>The objection you hear most: <b>{m.objections[0].label}</b> ({m.objections[0].n}×). Worth having a sharp answer ready.</>);
  }
  if (missingEods > 0) {
    focus.push(
      <span className="bad-text">
        You didn&apos;t sign off on {missingEods} day{missingEods > 1 ? "s" : ""} you worked, so those dials and targets are missing.
      </span>
    );
  }
  if (streak >= 2) focus.push(<>🔥 You&apos;re on a <b>{streak}-day</b> on-target streak.</>);

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE));
  const first = (profile?.full_name || "").split(" ")[0];

  return (
    <>
      <TopBar workspace={ws} active="me" role={role} />

      <main className="page reports me-page">
        <div className="report-head">
          <div>
            <h1 className="page-title">{first ? `${first}'s stats` : "My stats"}</h1>
            <p className="muted small">
              {periodText} · compared with the team average (all reps, per day worked) · only you and your managers see your numbers
            </p>
          </div>
          <div className="filters">
            <PeriodPicker
              key={`${range.fromDay}-${range.toDay}`}
              presets={PRESETS}
              current={range.key}
              fromDay={range.fromDay}
              toDay={range.toDay}
              maxDay={tzDate(TEAM_TZ)}
            />
          </div>
        </div>

        {/* Today */}
        <section className="card today-card">
          <div className="today-row">
            <div>
              <span className="muted small">Today</span>
              <p className="today-nums">
                <b>{today.pickups}</b> pick-ups · <b className="good-text">{today.booked}</b> booked
              </p>
            </div>
            {bookedGoal ? (
              <div className="goal">
                <div className="goal-label">
                  <span>Booked vs target</span>
                  <b>
                    {today.booked}/{bookedGoal}
                  </b>
                </div>
                <div className="goal-track">
                  <i style={{ width: `${Math.min(100, (today.booked / bookedGoal) * 100)}%` }} className={today.booked >= bookedGoal ? "done" : ""} />
                </div>
                <span className="muted small">
                  {today.booked >= bookedGoal
                    ? "Target hit ✓"
                    : `${bookedGoal - today.booked} more to hit target${t.min_dials ? `, or reach ${t.min_dials} dials` : ""}`}
                </span>
              </div>
            ) : null}
            <span className={`status ${today.signed_off ? "status-done" : "status-idle"}`}>
              {today.signed_off ? "Signed off" : "Not signed off yet"}
            </span>
          </div>
        </section>

        {/* KPIs vs team */}
        <section className="kpis report-kpis">
          <div className="kpi">
            <span>Pick-ups / day</span>
            <b>{myPick != null ? one(Math.round(myPick * 10) / 10) : "–"}</b>
            <Vs me={myPick} team={teamPick} fmt={(v) => one(Math.round(v * 10) / 10)} />
          </div>
          <div className="kpi good">
            <span>Booked / day</span>
            <b>{myBook != null ? one(Math.round(myBook * 10) / 10) : "–"}</b>
            <Vs me={myBook} team={teamBook} fmt={(v) => one(Math.round(v * 10) / 10)} />
          </div>
          <div className="kpi">
            <span>Book rate</span>
            <b>{pctTxt(m.booked, m.pickups)}</b>
            <Vs me={myRate} team={teamRate} fmt={(v) => `${Math.round(v * 100)}%`} />
          </div>
          <div className="kpi">
            <span>Days on target</span>
            <b>
              {m.eods ? pctTxt(m.days_hit, m.eods) : "–"}
              {m.eods > 0 && <small className="inline-small"> {m.days_hit} of {m.eods}</small>}
            </b>
            <Vs me={myHit} team={teamHit} fmt={(v) => `${Math.round(v * 100)}%`} />
          </div>
          <div className="kpi">
            <span>Avg dials / day</span>
            <b>{m.avg_dials ?? "–"}</b>
            <Vs me={m.avg_dials} team={tm.avg_dials} fmt={(v) => String(Math.round(v))} />
          </div>
          <div className="kpi">
            <span>Time between pick-ups</span>
            <b>{minTxt(m.gap_median)}</b>
            <Vs me={m.gap_median} team={tm.gap_median} lowerIsBetter fmt={(v) => `${Math.round(v)} min`} />
          </div>
        </section>

        {m.pickups === 0 && m.eods === 0 ? (
          <section className="card">
            <p className="muted empty">No calls logged {inPeriod} yet.</p>
          </section>
        ) : (
          <>
            {focus.length > 0 && (
              <section className="card findings">
                <h2>Your focus</h2>
                <ul>
                  {focus.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
                {m.pickups < 50 && (
                  <p className="muted small">Based on {m.pickups} pick-ups. These get more accurate the more you log.</p>
                )}
              </section>
            )}

            <div className="grid-2 align-start">
              {/* Where my calls die */}
              <section className="card">
                <h2>Where your calls end</h2>
                <p className="muted small">Share of your lost calls ({m.lost_staged}) by stage, vs the team.</p>
                {m.lost_staged === 0 ? (
                  <p className="muted small empty">No lost calls with a stage logged yet.</p>
                ) : (
                  <ul className="vs-list">
                    {stageRows.map((s) => {
                      const worse = m.lost_staged >= 8 && s.diff >= 0.1;
                      return (
                        <li key={s.id} title={`${s.label}: ${s.n} of your ${m.lost_staged} lost calls`}>
                          <span className="bl-label">{s.label}</span>
                          <span className="vs-track">
                            <i className={`me ${worse ? "worse" : ""}`} style={{ width: `${s.mine * 100}%` }} />
                            <i className="team" style={{ width: `${s.team * 100}%` }} />
                          </span>
                          <span className="bl-value">
                            <b className={worse ? "bad-text" : ""}>{Math.round(s.mine * 100)}%</b>{" "}
                            <em>team {Math.round(s.team * 100)}%</em>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="legend-row muted small">
                  <i className="sw me" /> You <i className="sw team" /> Team
                </p>
              </section>

              {/* Hours + objections */}
              <section className="card">
                <h2>Your hours</h2>
                <p className="muted small">Pick-ups and book rate by hour of day.</p>
                {m.hours.length === 0 ? (
                  <p className="muted small empty">No calls yet.</p>
                ) : (
                  <ul className="barlist">
                    {m.hours.map((h) => (
                      <li key={h.hour} title={`${slotTxt(h.hour)}: ${h.pickups} pick-ups, ${h.booked} booked`}>
                        <span className="bl-label">{slotTxt(h.hour)}</span>
                        <span className="bl-track">
                          <span className="bl-fill" style={{ width: `${(h.pickups / maxHourPick) * 100}%` }} />
                        </span>
                        <span className="bl-value">
                          {h.pickups}{" "}
                          <em className={bestHour?.hour === h.hour ? "good-text" : ""}>{pctTxt(h.booked, h.pickups)}</em>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <h3 className="h3 mt">Objections you hear most</h3>
                {m.objections.length === 0 ? (
                  <p className="muted small empty">None logged yet.</p>
                ) : (
                  <ol className="obj-list">
                    {m.objections.map((o) => (
                      <li key={o.label}>
                        {o.label} <span className="muted">({o.n})</span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>

            {/* Day by day */}
            <section className="card">
              <h2>Day by day</h2>
              <p className="muted small">Click a day to read your sign-off notes.</p>
              <div className="day-list">
                <div className="day-row day-head-row">
                  <span>Day</span>
                  <span className="num">Pick-ups</span>
                  <span className="num">Booked</span>
                  <span className="num">Book rate</span>
                  <span className="num">Dials</span>
                  <span>Target</span>
                  <span className="num">Energy</span>
                </div>
                {m.daily.map((d) => {
                  const hasNotes = d.went_well || d.improve || d.blockers;
                  const row = (
                    <>
                      <span>
                        <b>{fmtDay(d.day)}</b>
                      </span>
                      <span className="num">{d.pickups}</span>
                      <span className="num good-text">{d.booked}</span>
                      <span className="num">{pctTxt(d.booked, d.pickups)}</span>
                      <span className="num">{d.dials ?? <span className="muted">—</span>}</span>
                      <span>
                        {!d.signed_off ? (
                          <span className="muted small">{d.day === todayDay ? "in progress" : "no sign-off"}</span>
                        ) : d.on_target ? (
                          <span className="hit ok">✓ hit</span>
                        ) : (
                          <span className="hit miss">✗ missed</span>
                        )}
                      </span>
                      <span className="num">{d.energy ? `⚡ ${d.energy}/5` : <span className="muted">—</span>}</span>
                    </>
                  );
                  return hasNotes ? (
                    <details key={d.day} className="day-item">
                      <summary className="day-row">{row}</summary>
                      <div className="day-notes">
                        {d.went_well && (
                          <p>
                            <span className="lbl good-text">Worked</span> {d.went_well}
                          </p>
                        )}
                        {d.improve && (
                          <p>
                            <span className="lbl">Improve</span> {d.improve}
                          </p>
                        )}
                        {d.blockers && (
                          <p>
                            <span className="lbl bad-text">Blocker</span> {d.blockers}
                          </p>
                        )}
                      </div>
                    </details>
                  ) : (
                    <div key={d.day} className="day-item">
                      <div className="day-row">{row}</div>
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        )}

        {/* All my calls */}
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Your calls</h2>
              <p className="muted small">
                {count ?? 0} call{count === 1 ? "" : "s"} {inPeriod}
                {outcomeFilter ? ` · ${labels.get(outcomeFilter)?.label}` : ""}. To fix a mistake, use Undo or × in the
                extension within 15 minutes.
              </p>
            </div>
            <FilterSelect
              param="outcome"
              label="Outcome"
              value={outcomeFilter ?? ""}
              options={[{ value: "", label: "All outcomes" }, ...outcomes.map((o) => ({ value: o.id as string, label: o.label as string }))]}
            />
          </div>
          {!callRows?.length ? (
            <p className="muted small empty">No calls here.</p>
          ) : (
            <div className="table-wrap">
              <table className="table calls-table">
                <thead>
                  <tr>
                    <th>When</th>
                    {clientNames.size > 0 && <th>Client</th>}
                    <th>Outcome</th>
                    <th>Ended at</th>
                    <th>Objection</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {callRows.map((c) => {
                    const out = labels.get(c.outcome_id as string);
                    return (
                      <tr key={c.id}>
                        <td className="muted nowrap">{fmtTime(c.created_at as string)}</td>
                        {clientNames.size > 0 && <td>{c.client_id ? clientNames.get(c.client_id as string) ?? "—" : <span className="muted">—</span>}</td>}
                        <td className={out?.is_success ? "good-text" : ""}>
                          <b>{out?.label ?? "—"}</b>
                        </td>
                        <td>{c.stage_id ? labels.get(c.stage_id as string)?.label : <span className="muted">—</span>}</td>
                        <td>{c.objection_id ? labels.get(c.objection_id as string)?.label : <span className="muted">—</span>}</td>
                        <td className="note-cell">{c.note ?? <span className="muted">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {totalPages > 1 && (
            <nav className="pager" aria-label="Pages">
              {page > 1 ? <Link href={qs({ page: String(page - 1) })}>← Newer</Link> : <span />}
              <span className="muted small">
                Page {page} of {totalPages}
              </span>
              {page < totalPages ? <Link href={qs({ page: String(page + 1) })}>Older →</Link> : <span />}
            </nav>
          )}
        </section>
      </main>
    </>
  );
}
