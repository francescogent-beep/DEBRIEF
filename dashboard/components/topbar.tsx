import Link from "next/link";

type Props = {
  workspace?: { id: string; name: string };
  active?: "dashboard" | "reports" | "settings" | "me";
  role?: "manager" | "rep";
  children?: React.ReactNode;
};

export function TopBar({ workspace, active, role = "manager", children }: Props) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <Link href="/" className="brand-sm" aria-label="All workspaces">
          <span className="logo sm">D</span>
          <span className="wordmark">Debrief</span>
        </Link>
        {workspace && (
          <>
            <span className="sep">/</span>
            <span className="ws-name">{workspace.name}</span>
            <nav className="subnav">
              {role === "manager" && (
                <>
                  <Link href={`/w/${workspace.id}`} className={active === "dashboard" ? "on" : ""}>
                    Dashboard
                  </Link>
                  <Link href={`/w/${workspace.id}/reports`} className={active === "reports" ? "on" : ""}>
                    Reports
                  </Link>
                </>
              )}
              <Link href={`/w/${workspace.id}/me`} className={active === "me" ? "on" : ""}>
                My stats
              </Link>
              {role === "manager" && (
                <Link href={`/w/${workspace.id}/settings`} className={active === "settings" ? "on" : ""}>
                  Team & settings
                </Link>
              )}
            </nav>
          </>
        )}
      </div>
      <div className="topbar-right">
        {children}
        <form action="/auth/signout" method="post">
          <button className="btn link small">Sign out</button>
        </form>
      </div>
    </header>
  );
}
