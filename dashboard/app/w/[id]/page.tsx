import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/supabase-server";
import { TopBar } from "@/components/topbar";
import { TEAM_TZ, relativeTime, pct, tzDate, startOfDay } from "@/lib/time";

export const dynamic = "force-dynamic";

// The dashboard is the live view of one day (today by default).
// Anything over time — trends, best hours, coaching, client funnels — lives in Reports.

type Opt = { id: string; label: string; n: number; sort: number; is_success?: boolean };
type RepStat = {
  user_id: string;
  full_name: string | null;
  email: string | null;
  role: "manager" | "rep";
  conversations: number;
  booked: number;
  last_log: string | null;
};
type ClientStat = {
  id: string | null;
  name: string;
  active: boolean;
  conversations: number;
  booked: number;
  dials: number;
  reps: number;
};
type Stats = {
  totals: { conversations: number; booked: number; active_reps: number; dials: number };
  targets: { min_dials: number | null; min_booked: number | null };
  reps: RepStat[];
  clients: ClientStat[];
  outcomes: Opt[];
  stages: Opt[];
  objections: Opt[];
};

const QUIET_MIN = 45; // no call logged for this long during a shift = "quiet"
const BREAK_MAX_MS = 2 * 60 * 60 * 1000; // a forgotten break counts for at most 2h
const durTxt = (mins: number) => (mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Start of a calendar day (YYYY-MM-DD) in the team timezone, as a UTC instant.
function dayStart(day: string) {
  const today = tzDate(TEAM_TZ);
  const diff = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
  return startOfDay(TEAM_TZ, diff);
}
function shiftDay(day: string, by: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}
const fmtDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

export default async function Dashboard({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ day?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const today = tzDate(TEAM_TZ);
  const day = sp.day && DAY_RE.test(sp.day) && sp.day < today ? sp.day : today;
  const isToday = day === today;

  const { supabase, user } = await requireUser();
  if (!user) redirect("/login");

  const { data: ws } = await supabase.from("workspaces").select("id,name").eq("id", id).single();
  if (!ws) notFound();

  const from = dayStart(day);
  const to = new Date(from.getTime() + 86_400_000);
  const { data: statsData, error } = await supabase.rpc("workspace_stats", {
    p_workspace: id,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_tz: TEAM_TZ,
  });

  if (error) {
    // Reps (not managers) have their own page.
    const { data: isMember } = await supabase.rpc("is_member", { ws: id });
    if (isMember) redirect(`/w/${id}/me`);
    return (
      <>
        <TopBar workspace={ws} active="dashboard" />
        <main className="page narrow">
          <section className="card">
            <h2>Managers only</h2>
            <p className="muted">
              The dashboard is for managers. Reps log calls and sign off their day from the Debrief Chrome extension
              or the <a href="/log">web logger</a>.
            </p>
          </section>
        </main>
      </>
    );
  }
  const stats = statsData as Stats;

  const [{ data: eods }, { data: notes }, { data: breakRows }] = await Promise.all([
    supabase
      .from("eods")
      .select(
        "id,rep_id,day,dials,dials_by_client,conversations,booked,went_well,improve,blockers,energy,updated_at,rep:profiles(full_name,email)"
      )
      .eq("workspace_id", id)
      .eq("day", day)
      .order("updated_at", { ascending: false }),
    supabase
      .from("call_logs")
      .select("id,note,created_at,outcome_id,stage_id,objection_id,client_id,rep:profiles(full_name,email)")
      .eq("workspace_id", id)
      .not("note", "is", null)
      .gte("created_at", from.toISOString())
      .lt("created_at", to.toISOString())
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("breaks")
      .select("rep_id,started_at,ended_at")
      .eq("workspace_id", id)
      .gte("started_at", new Date(from.getTime() - BREAK_MAX_MS).toISOString())
      .lt("started_at", to.toISOString()),
  ]);

  const labels = new Map<string, Opt>();
  for (const o of [...stats.outcomes, ...stats.stages, ...stats.objections]) labels.set(o.id, o);

  const name = (r: { full_name?: string | null; email?: string | null } | null) =>
    r?.full_name || r?.email?.split("@")[0] || "Someone";

  // Targets: on target = min dials OR min booked (whichever are set).
  const t = stats.targets ?? { min_dials: null, min_booked: null };
  const hasTargets = t.min_dials != null || t.min_booked != null;
  const hitDay = (e: { dials: number | null; booked: number }) =>
    !hasTargets ||
    (t.min_dials != null && (e.dials ?? 0) >= t.min_dials) ||
    (t.min_booked != null && e.booked >= t.min_booked);
  const targetText = [
    t.min_dials != null ? `${t.min_dials} dials` : null,
    t.min_booked != null ? `${t.min_booked} booked` : null,
  ]
    .filter(Boolean)
    .join(" or ");

  const eodByRep = new Map((eods ?? []).map((e) => [e.rep_id as string, e]));
  const { conversations, booked } = stats.totals;

  // Breaks: effective end = ended_at, or now while running (capped at 2h if forgotten).
  const now = Date.now();
  const breaks = (breakRows ?? []).map((b) => {
    const s = Date.parse(b.started_at as string);
    const e = b.ended_at ? Date.parse(b.ended_at as string) : Math.min(now, s + BREAK_MAX_MS);
    return { rep: b.rep_id as string, s, e, open: !b.ended_at && now - s < BREAK_MAX_MS };
  });
  const breakMin = (rep: string) =>
    Math.round(
      breaks
        .filter((b) => b.rep === rep)
        .reduce((a, b) => a + Math.max(0, Math.min(b.e, to.getTime()) - Math.max(b.s, from.getTime())), 0) / 60_000
    );
  const openBreak = (rep: string) => (isToday ? breaks.find((b) => b.rep === rep && b.open) : undefined);
  const lastBreakEnd = (rep: string) => Math.max(0, ...breaks.filter((b) => b.rep === rep && !b.open).map((b) => b.e));

  // Team list: every rep, plus managers who logged calls.
  type Status = { key: "done" | "live" | "quiet" | "idle" | "none" | "break"; text: string; order: number };
  const statusOf = (r: RepStat): Status => {
    if (eodByRep.has(r.user_id)) return { key: "done", text: "Signed off", order: 3 };
    const ob = openBreak(r.user_id);
    if (ob) return { key: "break", text: `On break ${durTxt(Math.max(1, Math.round((now - ob.s) / 60_000)))}`, order: 1 };
    if (!r.last_log) return { key: "idle", text: isToday ? "No calls yet" : "No calls", order: 2 };
    if (!isToday) return { key: "none", text: "No sign-off", order: 1 };
    // Quiet = no call since the last call or the end of the last break, whichever is later.
    const since = Math.max(new Date(r.last_log).getTime(), lastBreakEnd(r.user_id));
    const mins = Math.round((now - since) / 60_000);
    if (mins < QUIET_MIN) return { key: "live", text: "Logging", order: 0 };
    return { key: "quiet", text: `Quiet ${durTxt(mins)}`, order: 1 };
  };
  const team = stats.reps
    .filter((r) => r.role === "rep" || r.conversations > 0)
    .map((r) => ({ r, s: statusOf(r), eod: eodByRep.get(r.user_id) }))
    .sort((a, b) => a.s.order - b.s.order || b.r.booked - a.r.booked || b.r.conversations - a.r.conversations);
  const repCount = stats.reps.filter((r) => r.role === "rep").length;
  const signedOff = eods?.length ?? 0;
  const onTarget = (eods ?? []).filter(hitDay).length;
  const quietReps = team.filter((x) => x.s.key === "quiet").length;
  const blockers = (eods ?? []).filter((e) => e.blockers);

  const clients = (stats.clients ?? []).filter((c) => c.conversations > 0 || c.dials > 0);
  const clientNames = new Map((stats.clients ?? []).filter((c) => c.id).map((c) => [c.id as string, c.name]));
  const hasClients = (stats.clients ?? []).some((c) => c.id);

  return (
    <>
      <TopBar workspace={ws} active="dashboard">
        <Link href={`/w/${id}/settings#export`} className="btn small export-btn">
          ⬇ Export / Google Sheets
        </Link>
      </TopBar>

      <main className="page">
        <div className="day-head">
          <div>
            <h1 className="page-title">{isToday ? "Today" : fmtDay(day)}</h1>
            <p className="muted small">
              {isToday ? `${fmtDay(day)} · live` : "Past day"} ·{" "}
              <Link href={`/w/${id}/reports`}>Trends, best times and coaching are in Reports →</Link>
            </p>
          </div>
          <nav className="range" aria-label="Day">
            <Link href={`?day=${shiftDay(day, -1)}`}>← Previous day</Link>
            <Link href="?" className={isToday ? "on" : ""}>
              Today
            </Link>
            {!isToday && <Link href={shiftDay(day, 1) >= today ? "?" : `?day=${shiftDay(day, 1)}`}>Next day →</Link>}
          </nav>
        </div>

        <section className="kpis">
          <div className="kpi">
            <span>Pick-ups</span>
            <b>{conversations}</b>
          </div>
          <div className="kpi good">
            <span>Booked</span>
            <b>{booked}</b>
          </div>
          <div className="kpi">
            <span>Book rate</span>
            <b>{pct(booked, conversations)}</b>
          </div>
          <div className="kpi">
            <span title="From end-of-day sign-offs">Dials</span>
            <b>{signedOff ? stats.totals.dials.toLocaleString() : "–"}</b>
            {signedOff > 0 && signedOff < repCount && <small className="muted">from {signedOff} sign-offs</small>}
          </div>
          <div className="kpi">
            <span>Signed off</span>
            <b>
              {signedOff}
              <small>/{repCount}</small>
            </b>
          </div>
          <div className="kpi">
            <span title={targetText ? `On target = ${targetText}` : undefined}>On target</span>
            <b>
              {hasTargets ? onTarget : "–"}
              {hasTargets && <small>/{repCount}</small>}
            </b>
          </div>
        </section>

        {isToday && quietReps > 0 && (
          <p className="headline">
            <b>{quietReps}</b> rep{quietReps > 1 ? "s haven't" : " hasn't"} logged a call in {QUIET_MIN}+ minutes.
          </p>
        )}

        {/* Team */}
        <section className="card">
          <h2>Team</h2>
          {team.length === 0 ? (
            <p className="muted small empty">
              No reps yet. Share a rep invite code from <Link href={`/w/${id}/settings`}>Team & settings</Link>.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Rep</th>
                    <th>Status</th>
                    <th className="num">Pick-ups</th>
                    <th className="num">Booked</th>
                    <th className="num">Book rate</th>
                    <th className="num">Dials</th>
                    <th>Target</th>
                    <th className="num">Breaks</th>
                    <th>Last call</th>
                  </tr>
                </thead>
                <tbody>
                  {team.map(({ r, s, eod }) => (
                    <tr key={r.user_id}>
                      <td>
                        <Link href={`/w/${id}/reports?rep=${r.user_id}`} className="row-link" title="Open this rep's report">
                          <b>{name(r)}</b>
                        </Link>
                        {r.role === "manager" && <span className="tag">manager</span>}
                      </td>
                      <td>
                        <span className={`status status-${s.key}`}>{s.text}</span>
                      </td>
                      <td className="num">{r.conversations}</td>
                      <td className="num good-text">{r.booked}</td>
                      <td className="num">{pct(r.booked, r.conversations)}</td>
                      <td className="num">{eod?.dials != null ? eod.dials.toLocaleString() : <span className="muted">—</span>}</td>
                      <td>
                        {eod && hasTargets ? (
                          <span className={`hit ${hitDay(eod) ? "ok" : "miss"}`} title={`On target = ${targetText}`}>
                            {hitDay(eod) ? "✓ hit" : "✗ missed"}
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="num">
                        {(() => {
                          const m = breakMin(r.user_id);
                          return m ? durTxt(m) : <span className="muted">—</span>;
                        })()}
                      </td>
                      <td className="muted">{r.last_log ? (isToday ? relativeTime(r.last_log) : new Date(r.last_log).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TEAM_TZ })) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {hasClients && clients.length > 0 && (
          <section className="card">
            <h2>Clients {isToday ? "today" : "this day"}</h2>
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th className="num">Pick-ups</th>
                    <th className="num">Booked</th>
                    <th className="num">Book rate</th>
                    <th className="num">Reps</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => (
                    <tr key={c.id ?? "none"} className={c.id ? "" : "muted-row"}>
                      <td>
                        {c.id ? (
                          <Link href={`/w/${id}/reports?client=${c.id}`} className="row-link" title="Open this client's report">
                            <b>{c.name}</b>
                          </Link>
                        ) : (
                          <span className="muted">{c.name}</span>
                        )}
                      </td>
                      <td className="num">{c.conversations}</td>
                      <td className="num good-text">{c.booked}</td>
                      <td className="num">{pct(c.booked, c.conversations)}</td>
                      <td className="num">{c.reps}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <div className="grid-2 align-start">
          {/* EOD feed */}
          <section className="card">
            <h2>End-of-day sign-offs</h2>
            {blockers.length > 0 && (
              <div className="blockers">
                <b>
                  {blockers.length} blocker{blockers.length > 1 ? "s" : ""} flagged
                </b>
                <ul>
                  {blockers.map((e) => (
                    <li key={e.id}>
                      <span className="muted">{name(e.rep as never)}:</span> {e.blockers}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!eods?.length ? (
              <p className="muted small empty">
                {isToday ? "Nobody has signed off yet today." : "Nobody signed off this day."}
              </p>
            ) : (
              <ul className="feed">
                {eods.map((e) => (
                  <li key={e.id} className="eod">
                    <div className="eod-head">
                      <b>{name(e.rep as never)}</b>
                      <span className="eod-stats">
                        {hasTargets && (
                          <span className={`hit ${hitDay(e) ? "ok" : "miss"}`} title={`On target = ${targetText}`}>
                            {hitDay(e) ? "✓ on target" : "✗ missed target"}
                          </span>
                        )}{" "}
                        {e.dials ?? "?"} dials · {e.booked} booked · {e.conversations} pick-ups
                      </span>
                      {e.energy && (
                        <span className="energy" title="Energy (1–5)">
                          ⚡ {e.energy}/5
                        </span>
                      )}
                    </div>
                    {hasClients && e.dials_by_client && Object.keys(e.dials_by_client).length > 1 && (
                      <p className="small muted">
                        Dials:{" "}
                        {Object.entries(e.dials_by_client as Record<string, number>)
                          .map(([k, v]) => `${clientNames.get(k) ?? "No client"} ${v}`)
                          .join(" · ")}
                      </p>
                    )}
                    {e.went_well && (
                      <p>
                        <span className="lbl good-text">Worked</span> {e.went_well}
                      </p>
                    )}
                    {e.improve && (
                      <p>
                        <span className="lbl">Improve</span> {e.improve}
                      </p>
                    )}
                    {e.blockers && (
                      <p>
                        <span className="lbl bad-text">Blocker</span> {e.blockers}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Call notes */}
          <section className="card">
            <h2>Call notes</h2>
            {!notes?.length ? (
              <p className="muted small empty">No notes {isToday ? "yet today" : "this day"}. Reps can add one when logging a call.</p>
            ) : (
              <ul className="feed">
                {notes.map((n) => (
                  <li key={n.id} className="note">
                    <div className="eod-head">
                      <b>{name(n.rep as never)}</b>
                      <span className="muted small">
                        {isToday
                          ? relativeTime(n.created_at)
                          : new Date(n.created_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TEAM_TZ })}
                      </span>
                    </div>
                    <p className="note-tags">
                      {n.client_id && clientNames.get(n.client_id) && (
                        <span className="tag client-tag">{clientNames.get(n.client_id)}</span>
                      )}
                      {[n.outcome_id, n.stage_id, n.objection_id]
                        .map((x) => (x ? labels.get(x)?.label : null))
                        .filter(Boolean)
                        .map((l) => (
                          <span key={l} className="tag">
                            {l}
                          </span>
                        ))}
                    </p>
                    <p>{n.note}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
