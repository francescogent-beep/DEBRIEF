import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/supabase-server";
import { TopBar } from "@/components/topbar";
import { BarList, DailyChart } from "@/components/charts";
import { RANGES, TEAM_TZ, rangeWindow, relativeTime, pct, tzDate, type RangeKey } from "@/lib/time";

export const dynamic = "force-dynamic";

type Opt = { id: string; label: string; n: number; sort: number; is_success?: boolean };
type RepStat = {
  user_id: string;
  full_name: string | null;
  email: string | null;
  role: "manager" | "rep";
  conversations: number;
  booked: number;
  last_log: string | null;
  eods: number;
  avg_energy: number | null;
  dials: number;
  days_hit: number;
  stages: Record<string, number> | null;
};
type ClientStat = {
  id: string | null;
  name: string;
  active: boolean;
  conversations: number;
  booked: number;
  dials: number;
  reps: number;
  top_stage: string | null;
  top_objection: string | null;
};
type RepClientStat = {
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
type Stats = {
  totals: { conversations: number; booked: number; active_reps: number; dials: number };
  targets: { min_dials: number | null; min_booked: number | null };
  reps: RepStat[];
  clients: ClientStat[];
  rep_clients: RepClientStat[];
  outcomes: Opt[];
  stages: Opt[];
  objections: Opt[];
  daily: { day: string; conversations: number; booked: number }[];
};

export default async function Dashboard({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string; client?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const range: RangeKey = (["today", "7d", "30d"] as const).includes(sp.range as RangeKey)
    ? (sp.range as RangeKey)
    : "7d";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const clientFilter = sp.client && UUID.test(sp.client) ? sp.client : null;
  const qs = (next: { range?: string; client?: string | null }) => {
    const params = new URLSearchParams();
    params.set("range", next.range ?? range);
    const c = next.client === undefined ? clientFilter : next.client;
    if (c) params.set("client", c);
    return `?${params.toString()}`;
  };

  const { supabase, user } = await requireUser();
  if (!user) redirect("/login");

  const { data: ws } = await supabase.from("workspaces").select("id,name").eq("id", id).single();
  if (!ws) notFound();

  const win = rangeWindow(range);
  const { data: statsData, error } = await supabase.rpc("workspace_stats", {
    p_workspace: id,
    p_from: win.from.toISOString(),
    p_to: win.to.toISOString(),
    p_tz: TEAM_TZ,
    ...(clientFilter ? { p_client: clientFilter } : {}),
  });

  if (error) {
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

  const [{ data: eods }, { data: notes }] = await Promise.all([
    supabase
      .from("eods")
      .select("id,day,dials,dials_by_client,conversations,booked,went_well,improve,blockers,energy,updated_at,rep:profiles(full_name,email)")
      .eq("workspace_id", id)
      .gte("day", win.fromDay)
      .order("day", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(60),
    (() => {
      let q = supabase
        .from("call_logs")
        .select("id,note,created_at,outcome_id,stage_id,objection_id,client_id,rep:profiles(full_name,email)")
        .eq("workspace_id", id)
        .not("note", "is", null)
        .gte("created_at", win.from.toISOString());
      if (clientFilter) q = q.eq("client_id", clientFilter);
      return q.order("created_at", { ascending: false }).limit(30);
    })(),
  ]);

  const labels = new Map<string, Opt>();
  for (const o of [...stats.outcomes, ...stats.stages, ...stats.objections]) labels.set(o.id, o);

  const { conversations, booked } = stats.totals;
  const lost = conversations - booked;
  const objectionTotal = stats.objections.reduce((s, o) => s + o.n, 0);
  const reps = stats.reps.filter((r) => r.role === "rep" || r.conversations > 0);
  const repCount = stats.reps.filter((r) => r.role === "rep").length;
  const today = tzDate(TEAM_TZ);
  const eodsToday = (eods ?? []).filter((e) => e.day === today).length;
  const blockers = (eods ?? []).filter((e) => e.blockers);

  // Daily targets
  const t = stats.targets ?? { min_dials: null, min_booked: null };
  const hasTargets = t.min_dials != null || t.min_booked != null;
  const dialsOk = (d: number | null) => t.min_dials == null || (d ?? 0) >= t.min_dials;
  const bookedOk = (b: number) => t.min_booked == null || b >= t.min_booked;
  // On target = min dials OR min booked (whichever targets are set).
  const hitDay = (e: { dials: number | null; booked: number }) =>
    !hasTargets ||
    (t.min_dials != null && (e.dials ?? 0) >= t.min_dials) ||
    (t.min_booked != null && e.booked >= t.min_booked);
  const eodsHitToday = (eods ?? []).filter((e) => e.day === today && hitDay(e)).length;
  const eodsHitRange = (eods ?? []).filter(hitDay).length;

  // Fill in days without calls so the trend is honest.
  const byDay = new Map(stats.daily.map((d) => [d.day, d]));
  const days = Array.from({ length: win.days }, (_, i) => {
    const day = tzDate(TEAM_TZ, win.days - 1 - i);
    return byDay.get(day) ?? { day, conversations: 0, booked: 0 };
  });

  const topStage = [...stats.stages].sort((a, b) => b.n - a.n)[0];
  const topObjection = stats.objections[0];

  const name = (r: { full_name?: string | null; email?: string | null } | null) =>
    r?.full_name || r?.email?.split("@")[0] || "Someone";

  // Clients
  const clientList = stats.clients ?? [];
  const realClients = clientList.filter((c) => c.id);
  const clientNames = new Map(realClients.map((c) => [c.id as string, c.name]));
  const hasClients = realClients.length > 0;
  const activeClient = clientFilter ? clientNames.get(clientFilter) ?? "Client" : null;
  const repClients = stats.rep_clients ?? [];
  const targetText = [
    t.min_dials != null ? `${t.min_dials} dials` : null,
    t.min_booked != null ? `${t.min_booked} booked` : null,
  ]
    .filter(Boolean)
    .join(" or ");

  return (
    <>
      <TopBar workspace={ws} active="dashboard">
        <Link href={`/w/${id}/settings#export`} className="btn small export-btn">
          ⬇ Export / Google Sheets
        </Link>
        <nav className="range" aria-label="Time range">
          {RANGES.map((r) => (
            <Link key={r.key} href={qs({ range: r.key })} className={r.key === range ? "on" : ""}>
              {r.label}
            </Link>
          ))}
        </nav>
      </TopBar>

      <main className="page">
        {hasClients && (
          <nav className="client-filter" aria-label="Filter by client">
            <span className="muted small">Client</span>
            <Link href={qs({ client: null })} className={!clientFilter ? "on" : ""}>
              All clients
            </Link>
            {realClients.map((c) => (
              <Link key={c.id} href={qs({ client: c.id })} className={clientFilter === c.id ? "on" : ""}>
                {c.name}
              </Link>
            ))}
          </nav>
        )}
        {activeClient && (
          <p className="filter-note">
            Showing <b>{activeClient}</b> only. Targets and end-of-day sign-offs are per rep across all clients.
          </p>
        )}

        {/* KPIs */}
        <section className="kpis">
          <div className="kpi">
            <span>Dials</span>
            <b>{stats.totals.dials.toLocaleString()}</b>
          </div>
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
            <span title={targetText ? `On target = ${targetText}` : undefined}>
              {range === "today" ? "On target today" : "Days on target"}
            </span>
            <b>
              {hasTargets ? (range === "today" ? eodsHitToday : eodsHitRange) : "–"}
              {hasTargets && <small>/{range === "today" ? repCount : eods?.length ?? 0}</small>}
            </b>
          </div>
          <div className="kpi">
            <span>{range === "today" ? "Signed off today" : "EOD sign-offs"}</span>
            <b>
              {range === "today" ? eodsToday : eods?.length ?? 0}
              {range === "today" && <small>/{repCount}</small>}
            </b>
          </div>
        </section>

        {conversations > 0 && (
          <p className="headline">
            {topStage?.n ? (
              <>
                Most lost calls die at <b>{topStage.label}</b> ({pct(topStage.n, lost)} of lost calls)
              </>
            ) : (
              <>No stages logged yet</>
            )}
            {topObjection?.n ? (
              <>
                {" "}· top objection: <b>{topObjection.label}</b>
              </>
            ) : null}
          </p>
        )}

        {/* Where calls die + objections */}
        <div className="grid-2">
          <section className="card">
            <h2>Where calls die</h2>
            <p className="muted small">Share of lost calls ({lost}) by the stage they ended at.</p>
            <BarList items={stats.stages} total={lost} empty="No lost calls logged in this period." />
          </section>
          <section className="card">
            <h2>Top objections</h2>
            <p className="muted small">How often each objection came up.</p>
            <BarList
              items={stats.objections.filter((o) => o.n > 0)}
              total={objectionTotal}
              empty="No objections logged in this period."
              unit="times"
            />
          </section>
        </div>

        {range !== "today" && (
          <section className="card">
            <h2>Daily trend</h2>
            <DailyChart days={days} />
          </section>
        )}

        {/* By client */}
        {hasClients && !clientFilter && (
          <section className="card">
            <h2>By client</h2>
            <p className="muted small">Results for each firm your reps call for. Click a client to filter the whole dashboard.</p>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th className="num">Dials</th>
                    <th className="num">Pick-ups</th>
                    <th className="num">Booked</th>
                    <th className="num">Book rate</th>
                    <th className="num">Reps</th>
                    <th>Most died at</th>
                    <th>Top objection</th>
                  </tr>
                </thead>
                <tbody>
                  {clientList.map((c) => (
                    <tr key={c.id ?? "none"} className={c.id ? "" : "muted-row"}>
                      <td>
                        {c.id ? (
                          <Link href={qs({ client: c.id })} className="row-link">
                            <b>{c.name}</b>
                          </Link>
                        ) : (
                          <span className="muted">{c.name}</span>
                        )}
                      </td>
                      <td className="num">{c.dials ? c.dials.toLocaleString() : "—"}</td>
                      <td className="num">{c.conversations}</td>
                      <td className="num good-text">{c.booked}</td>
                      <td className="num">{pct(c.booked, c.conversations)}</td>
                      <td className="num">{c.reps}</td>
                      <td>{c.top_stage ?? <span className="muted">—</span>}</td>
                      <td>{c.top_objection ?? <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {hasClients && (
          <section className="card">
            <h2>Rep × client{activeClient ? ` — ${activeClient}` : ""}</h2>
            <p className="muted small">How each rep performs for each client they called for.</p>
            {repClients.length === 0 ? (
              <p className="muted small empty">No calls logged in this period.</p>
            ) : (
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
                      const firstOfRep = i === 0 || repClients[i - 1].user_id !== rc.user_id;
                      return (
                        <tr key={`${rc.user_id}-${rc.client_id ?? "none"}`} className={firstOfRep ? "group-start" : ""}>
                          <td>{firstOfRep ? <b>{rc.rep_name || "Someone"}</b> : ""}</td>
                          <td className={rc.client_id ? "" : "muted"}>{rc.client_name}</td>
                          <td className="num">{rc.dials ? rc.dials.toLocaleString() : "—"}</td>
                          <td className="num">{rc.conversations}</td>
                          <td className="num good-text">{rc.booked}</td>
                          <td className="num">{pct(rc.booked, rc.conversations)}</td>
                          <td>{rc.top_stage ?? <span className="muted">—</span>}</td>
                          <td>{rc.top_objection ?? <span className="muted">—</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* Reps */}
        <section className="card">
          <h2>Reps</h2>
          {reps.length === 0 ? (
            <p className="muted small empty">
              No reps yet. Share a rep invite code from <Link href={`/w/${id}/settings`}>Team & settings</Link>.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Rep</th>
                    <th className="num">Dials</th>
                    <th className="num">Pick-ups</th>
                    <th className="num">Booked</th>
                    <th className="num">Book rate</th>
                    <th>Most died at</th>
                    <th className="num">On target</th>
                    <th className="num">Energy</th>
                    <th>Last log</th>
                  </tr>
                </thead>
                <tbody>
                  {reps.map((r) => {
                    const died = Object.entries(r.stages ?? {}).sort((a, b) => b[1] - a[1])[0];
                    const lostR = r.conversations - r.booked;
                    return (
                      <tr key={r.user_id}>
                        <td>
                          <b>{name(r)}</b>
                          {r.role === "manager" && <span className="tag">manager</span>}
                        </td>
                        <td className="num">{r.dials ? r.dials.toLocaleString() : "—"}</td>
                        <td className="num">{r.conversations}</td>
                        <td className="num good-text">{r.booked}</td>
                        <td className="num">{pct(r.booked, r.conversations)}</td>
                        <td>
                          {died ? (
                            <>
                              {labels.get(died[0])?.label} <span className="muted">({pct(died[1], lostR)})</span>
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className="num">
                          {r.eods ? (
                            <span className={`hit ${r.days_hit === r.eods ? "ok" : "miss"}`}>
                              {r.days_hit}/{r.eods} days
                            </span>
                          ) : (
                            <span className="muted">no EODs</span>
                          )}
                        </td>
                        <td className="num">{r.avg_energy ?? "—"}</td>
                        <td className="muted">{relativeTime(r.last_log)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="grid-2 align-start">
          {/* EOD feed */}
          <section className="card">
            <h2>End-of-day sign-offs</h2>
            {blockers.length > 0 && (
              <div className="blockers">
                <b>{blockers.length} blocker{blockers.length > 1 ? "s" : ""} flagged</b>
                <ul>
                  {blockers.slice(0, 5).map((e) => (
                    <li key={e.id}>
                      <span className="muted">{name(e.rep as never)}:</span> {e.blockers}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!eods?.length ? (
              <p className="muted small empty">No sign-offs in this period yet.</p>
            ) : (
              <ul className="feed">
                {eods.map((e) => (
                  <li key={e.id} className="eod">
                    <div className="eod-head">
                      <b>{name(e.rep as never)}</b>
                      <span className="muted small">
                        {new Date(`${e.day}T12:00:00`).toLocaleDateString("en-US", {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
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
              <p className="muted small empty">No notes in this period. Reps can add one when logging a call.</p>
            ) : (
              <ul className="feed">
                {notes.map((n) => (
                  <li key={n.id} className="note">
                    <div className="eod-head">
                      <b>{name(n.rep as never)}</b>
                      <span className="muted small">{relativeTime(n.created_at)}</span>
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
