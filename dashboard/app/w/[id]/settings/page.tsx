import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/supabase-server";
import { TopBar } from "@/components/topbar";
import {
  addOption,
  createInvite,
  renameWorkspace,
  setInviteActive,
  updateMember,
  updateOption,
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

  const { data: ws } = await supabase.from("workspaces").select("id,name").eq("id", id).single();
  if (!ws) notFound();

  const [{ data: invites }, { data: members }, { data: options }] = await Promise.all([
    supabase.from("invites").select("*").eq("workspace_id", id).order("created_at", { ascending: false }),
    supabase
      .from("memberships")
      .select("user_id,role,active,created_at,profile:profiles(full_name,email)")
      .eq("workspace_id", id)
      .order("created_at"),
    supabase.from("options").select("*").eq("workspace_id", id).order("sort"),
  ]);

  const { data: isManager } = await supabase.rpc("is_manager", { ws: id });
  if (!isManager || !invites) redirect(`/w/${id}`);

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
