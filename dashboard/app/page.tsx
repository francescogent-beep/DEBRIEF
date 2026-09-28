import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/supabase-server";
import { TopBar } from "@/components/topbar";
import { JoinForm, CreateWorkspaceForm } from "@/components/forms";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { supabase, user } = await requireUser();
  if (!user) redirect("/login");

  const [{ data: profile }, { data: memberships }] = await Promise.all([
    supabase.from("profiles").select("full_name,is_owner").eq("id", user.id).single(),
    supabase
      .from("memberships")
      .select("role, workspace:workspaces(id,name)")
      .eq("user_id", user.id)
      .eq("active", true),
  ]);

  const isOwner = !!profile?.is_owner;
  const roles = new Map<string, string>();
  for (const m of memberships ?? []) {
    const ws = m.workspace as unknown as { id: string; name: string } | null;
    if (ws) roles.set(ws.id, m.role);
  }

  // Owner sees every workspace; everyone else sees their own.
  const { data: workspaces } = await supabase.from("workspaces").select("id,name,created_at").order("created_at");
  const list = (workspaces ?? []).map((w) => ({ ...w, role: roles.get(w.id) ?? (isOwner ? "owner" : "rep") }));
  const managed = list.filter((w) => w.role !== "rep");

  // Managers with exactly one team go straight to it.
  if (!isOwner && managed.length === 1 && list.length === 1) redirect(`/w/${managed[0].id}`);

  return (
    <>
      <TopBar />
      <main className="page narrow">
        <h1 className="page-title">Hi {profile?.full_name?.split(" ")[0] || "there"} 👋</h1>

        {list.length > 0 && (
          <section className="card">
            <h2>Your workspaces</h2>
            <ul className="ws-list">
              {list.map((w) => (
                <li key={w.id}>
                  {w.role === "rep" ? (
                    <div className="ws-row">
                      <span>{w.name}</span>
                      <span className="tag">rep</span>
                    </div>
                  ) : (
                    <Link href={`/w/${w.id}`} className="ws-row">
                      <span>{w.name}</span>
                      <span className="tag">{w.role}</span>
                    </Link>
                  )}
                </li>
              ))}
            </ul>
            {list.every((w) => w.role === "rep") && (
              <p className="muted small">
                Reps log calls from the Debrief Chrome extension. The dashboard is for managers.
              </p>
            )}
          </section>
        )}

        <div className={isOwner ? "grid-2" : ""}>
          <section className="card">
            <h2>Join a workspace</h2>
            <p className="muted small">Got an invite code from your manager? Enter it here.</p>
            <JoinForm />
          </section>
          {isOwner && (
            <section className="card">
              <h2>New workspace</h2>
              <p className="muted small">Creates the team with default outcomes, stages and objections, plus invite codes.</p>
              <CreateWorkspaceForm />
            </section>
          )}
        </div>
      </main>
    </>
  );
}
