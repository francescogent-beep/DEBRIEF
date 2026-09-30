import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { CopyButton } from "@/components/copy-button";
import { EXPORTS } from "@/lib/exports";
import { requireUser } from "@/lib/supabase-server";
import { TopBar } from "@/components/topbar";
import {
  addClient,
  addOption,
  resetExportKey,
  createInvite,
  renameWorkspace,
  setInviteActive,
  updateMember,
  updateOption,
  updateClient,
  updateTargets,
} from "@/app/actions";

export const dynamic = "force-dynamic";

const KINDS = [
  { kind: "outcome", title: "Outcomes", hint: "How an answered call ended. The first “success” outcome counts as booked." },
  { kind: "stage", title: "Stages", hint: "Where a lost call died, in call order." },
  { kind: "objection", title: "Objections", hint: "One-tap reasons reps can attach to a call." },
] as const;

export default async function Settings({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await requireUser();
  if (!user) redirect("/login");

  const { data: ws } = await supabase.from("workspaces").select("id,name,min_dials,min_booked").eq("id", id).single();
  if (!ws) notFound();

  const [{ data: invites }, { data: members }, { data: options }, { data: clients }] = await Promise.all([
    supabase.from("invites").select("*").eq("workspace_id", id).order("created_at", { ascending: false }),
    supabase
      .from("memberships")
      .select("user_id,role,active,created_at,profile:profiles(full_name,email)")
      .eq("workspace_id", id)
      .order("created_at"),
    supabase.from("options").select("*").eq("workspace_id", id).order("sort"),
    supabase.from("clients").select("*").eq("workspace_id", id).order("sort").order("name"),
  ]);

  const { data: isManager } = await supabase.rpc("is_manager", { ws: id });
  if (!isManager || !invites) redirect(`/w/${id}`);

  // Exports: secret key + absolute base URL for Google Sheets.
  const { data: exportKey } = await supabase.rpc("get_export_key", { p_workspace: id });
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const exportBase = exportKey ? `${proto}://${host}/export/${exportKey}` : null;

  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;

  return (
    <>
      <TopBar workspace={ws} active="settings" />
      <main className="page">
        <div className="grid-2 align-start">
          {/* Invites */}
          <section className="card">
            <h2>Invite codes</h2>
            <p className="muted small">
              Reps enter a <b>rep code</b> in the Chrome extension. Managers enter a <b>manager code</b> here on the
              dashboard. Turn a code off anytime.
            </p>
            <table className="table compact">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Role</th>
                  <th className="num">Used</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {invites!.map((i) => (
                  <tr key={i.code} className={i.active ? "" : "off"}>
                    <td>
                      <code className="code">{i.code}</code>
                    </td>
                    <td>
                      <span className="tag">{i.role}</span>
                    </td>
                    <td className="num">{i.uses}</td>
                    <td className="right">
                      <form action={setInviteActive}>
                        {hidden("workspace_id", id)}
                        {hidden("code", i.code)}
                        {hidden("active", String(!i.active))}
                        <button className="btn link small">{i.active ? "Turn off" : "Turn on"}</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row">
              <form action={createInvite}>
                {hidden("workspace_id", id)}
                {hidden("role", "rep")}
                <button className="btn small">+ Rep code</button>
              </form>
              <form action={createInvite}>
                {hidden("workspace_id", id)}
                {hidden("role", "manager")}
                <button className="btn small">+ Manager code</button>
              </form>
            </div>
          </section>

          {/* Workspace */}
          <section className="card">
            <h2>Workspace</h2>
            <form action={renameWorkspace} className="row">
              {hidden("workspace_id", id)}
              <input name="name" defaultValue={ws.name} maxLength={80} aria-label="Workspace name" />
              <button className="btn">Rename</button>
            </form>

            <h2 className="mt">Daily targets</h2>
            <p className="muted small">
              Checked in every rep&apos;s end-of-day sign-off. A rep is <b>on target</b> when they hit the dials
              minimum <b>or</b> the booked minimum. Reps enter their dials; booked is counted from their logged calls.
              Leave a box empty to turn that target off.
            </p>
            <form action={updateTargets} className="targets-form">
              {hidden("workspace_id", id)}
              <label>
                Minimum dials
                <input name="min_dials" type="number" min={0} max={5000} defaultValue={ws.min_dials ?? ""} />
              </label>
              <label>
                Minimum booked
                <input name="min_booked" type="number" min={0} max={500} defaultValue={ws.min_booked ?? ""} />
              </label>
              <button className="btn">Save targets</button>
            </form>

            <h2 className="mt">Team</h2>
            {!members?.length ? (
              <p className="muted small">Nobody here yet.</p>
            ) : (
              <table className="table compact">
                <tbody>
                  {members.map((m) => {
                    const p = m.profile as unknown as { full_name: string | null; email: string | null } | null;
                    return (
                      <tr key={m.user_id} className={m.active ? "" : "off"}>
                        <td>
                          <b>{p?.full_name || p?.email}</b>
                          <div className="muted small">{p?.email}</div>
                        </td>
                        <td>
                          <form action={updateMember} className="inline">
                            {hidden("workspace_id", id)}
                            {hidden("user_id", m.user_id)}
                            {hidden("role", m.role === "manager" ? "rep" : "manager")}
                            <button className="btn link small" title="Switch role">
                              <span className="tag">{m.role}</span> ⇄
                            </button>
                          </form>
                        </td>
                        <td className="right">
                          {m.user_id !== user.id && (
                            <form action={updateMember}>
                              {hidden("workspace_id", id)}
                              {hidden("user_id", m.user_id)}
                              {hidden("active", String(!m.active))}
                              <button className="btn link small">{m.active ? "Remove" : "Restore"}</button>
                            </form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </div>

        {/* Exports */}
        <section className="card" id="export">
          <h2>Spreadsheets &amp; Google Sheets</h2>
          <p className="muted small">
            Download a spreadsheet, or connect a Google Sheet that <b>updates itself automatically</b> (about once an
            hour). Each covers the last 90 days.
          </p>
          {!exportBase ? (
            <p className="msg">Couldn&apos;t create the export link. Refresh the page to try again.</p>
          ) : (
            <>
              <ul className="export-list">
                {EXPORTS.map((e) => {
                  const url = `${exportBase}/${e.file}`;
                  const formula = `=IMPORTDATA("${url}")`;
                  return (
                    <li key={e.kind}>
                      <div className="export-head">
                        <div>
                          <b>{e.title}</b>
                          <p className="muted small">{e.description}</p>
                        </div>
                        <a className="btn small" href={`${url}?download`} download={e.file}>
                          ⬇ Download CSV
                        </a>
                      </div>
                      <div className="formula">
                        <code>{formula}</code>
                        <CopyButton text={formula} label="Copy for Google Sheets" />
                      </div>
                    </li>
                  );
                })}
              </ul>
              <details className="howto">
                <summary>How to connect a Google Sheet</summary>
                <ol>
                  <li>Create a new Google Sheet (sheets.new). Add one tab per report if you want all three.</li>
                  <li>Click <b>Copy for Google Sheets</b> next to a report above.</li>
                  <li>Click cell <b>A1</b> in the tab and paste. The data appears in a few seconds.</li>
                  <li>That&apos;s it: Google refreshes it about every hour. Build charts or other tabs on top of it.</li>
                </ol>
                <p className="muted small">
                  Anyone with these links can see this team&apos;s reports, so only share the sheet with people who
                  should. If a link leaks or someone leaves, reset it below; the old links and connected sheets stop
                  working and you paste the new formula.
                </p>
              </details>
              <form action={resetExportKey} className="reset-export">
                {hidden("workspace_id", id)}
                <button className="btn link small danger">Reset links (breaks connected sheets)</button>
              </form>
            </>
          )}
        </section>

        {/* Clients */}
        <section className="card">
          <h2>Clients</h2>
          <p className="muted small">
            The firms your reps call for. Reps pick one in the extension (&ldquo;Calling for&rdquo;) and every call is
            tagged with it, so the dashboard can break results down by client and by rep × client. Hidden clients
            disappear from the extension but keep their history.
          </p>
          <ul className="opt-list clients-list">
            {(clients ?? []).map((c) => (
              <li key={c.id} className={c.active ? "" : "off"}>
                <form action={updateClient} className="row">
                  {hidden("workspace_id", id)}
                  {hidden("id", c.id)}
                  <input name="name" defaultValue={c.name} maxLength={80} aria-label="Client name" />
                  <button className="btn small">Save</button>
                </form>
                <form action={updateClient}>
                  {hidden("workspace_id", id)}
                  {hidden("id", c.id)}
                  {hidden("active", String(!c.active))}
                  <button className="btn link small">{c.active ? "Hide" : "Show"}</button>
                </form>
              </li>
            ))}
          </ul>
          <form action={addClient} className="row">
            {hidden("workspace_id", id)}
            <input name="name" placeholder="Add client, e.g. Alcaton Advisors" maxLength={80} required />
            <button className="btn small">Add client</button>
          </form>
        </section>

        {/* Options */}
        <div className="grid-3 align-start">
          {KINDS.map(({ kind, title, hint }) => {
            const list = (options ?? []).filter((o) => o.kind === kind);
            return (
              <section className="card" key={kind}>
                <h2>{title}</h2>
                <p className="muted small">{hint}</p>
                <ul className="opt-list">
                  {list.map((o) => (
                    <li key={o.id} className={o.active ? "" : "off"}>
                      <form action={updateOption} className="row">
                        {hidden("workspace_id", id)}
                        {hidden("id", o.id)}
                        <input name="label" defaultValue={o.label} maxLength={60} aria-label={`${title} label`} />
                        <button className="btn small" title="Save label">Save</button>
                      </form>
                      <form action={updateOption}>
                        {hidden("workspace_id", id)}
                        {hidden("id", o.id)}
                        {hidden("active", String(!o.active))}
                        <button className="btn link small">{o.active ? "Hide" : "Show"}</button>
                      </form>
                      {o.is_success && <span className="tag good">booked</span>}
                    </li>
                  ))}
                </ul>
                <form action={addOption} className="row">
                  {hidden("workspace_id", id)}
                  {hidden("kind", kind)}
                  <input name="label" placeholder={`Add ${kind}…`} maxLength={60} required />
                  <button className="btn small">Add</button>
                </form>
              </section>
            );
          })}
        </div>
        <p className="muted small">
          Hidden options disappear from the extension but keep their history on the dashboard. Reps see changes the
          next time they open the panel.
        </p>
      </main>
    </>
  );
}
