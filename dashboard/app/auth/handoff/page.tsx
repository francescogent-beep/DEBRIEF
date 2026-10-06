"use client";

import { useEffect, useState } from "react";
import { createBrowserClient } from "@supabase/ssr";

// Opened by the extension / web logger ("My stats"): signs the rep in on the website
// with their current access token so they don't have to log in twice.
// The token arrives in the URL fragment (never sent to any server) and is removed
// from the address bar right away. The extension's refresh token is never shared,
// so the website session lasts until that access token expires (about an hour);
// clicking "My stats" again renews it.

function safeNext(raw: string | null) {
  return raw && raw.startsWith("/w/") && !raw.includes("//") ? raw : "/";
}

function tokenUser(at: string): string | null {
  try {
    const part = at.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part)).sub ?? null;
  } catch {
    return null;
  }
}

export default function Handoff() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const at = hash.get("at");
    const next = safeNext(hash.get("next"));
    window.history.replaceState(null, "", window.location.pathname);

    (async () => {
      const supabase = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      );
      const sub = at ? tokenUser(at) : null;
      // Already signed in on the website as the same person: just go.
      const { data } = await supabase.auth.getUser();
      if (data.user && (!sub || data.user.id === sub)) return window.location.replace(next);
      if (!at || !sub) return window.location.replace(`/login`);

      const { error } = await supabase.auth.setSession({ access_token: at, refresh_token: "extension-handoff" });
      if (error) {
        setFailed(true);
        return;
      }
      window.location.replace(next);
    })();
  }, []);

  return (
    <main className="auth">
      <div className="auth-card">
        {failed ? (
          <>
            <h1>Couldn&apos;t sign you in</h1>
            <p className="muted">
              Your session may have expired. <a href="/login">Sign in here</a> with the same email and password you use in
              the extension.
            </p>
          </>
        ) : (
          <p className="muted">Opening your stats…</p>
        )}
      </div>
    </main>
  );
}
