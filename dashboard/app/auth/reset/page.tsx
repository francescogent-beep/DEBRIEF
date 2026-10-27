"use client";

import { useEffect, useState } from "react";
import { createBrowserClient } from "@supabase/ssr";

// Landing page for the "reset your password" email link.
// Supabase sends the user here with a short-lived session in the URL fragment
// (#access_token=…&refresh_token=…&type=recovery), or ?code=… / ?token_hash=…
// depending on how the email was sent. We turn that into a session, then let
// the user pick a new password.

type Phase = "checking" | "ready" | "saving" | "error";

export default function ResetPassword() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [msg, setMsg] = useState<string | null>(null);

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const query = new URLSearchParams(window.location.search);
    window.history.replaceState(null, "", window.location.pathname);

    (async () => {
      const err = hash.get("error_description") || query.get("error_description");
      if (err) {
        setMsg(
          /expired|invalid/i.test(err)
            ? "This reset link has expired or was already used. Ask for a new one."
            : err.replace(/\+/g, " ")
        );
        return setPhase("error");
      }

      let error: { message: string } | null = null;
      const at = hash.get("access_token");
      const rt = hash.get("refresh_token");
      const code = query.get("code");
      const tokenHash = query.get("token_hash");

      if (at && rt) ({ error } = await supabase.auth.setSession({ access_token: at, refresh_token: rt }));
      else if (tokenHash) ({ error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" }));
      else if (code) ({ error } = await supabase.auth.exchangeCodeForSession(code));
      else {
        const { data } = await supabase.auth.getUser();
        if (!data.user) error = { message: "missing" };
      }

      if (error) {
        setMsg(
          error.message === "missing"
            ? "Open this page from the link in your reset email."
            : "This reset link didn't work. It may have expired, or it was opened in a different browser. Ask for a new one."
        );
        return setPhase("error");
      }
      setPhase("ready");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const pw = String(f.get("password"));
    const pw2 = String(f.get("password2"));
    if (pw !== pw2) return setMsg("The two passwords don't match.");
    setPhase("saving");
    setMsg(null);
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) {
      setMsg(error.message);
      return setPhase("ready");
    }
    // Sign out so they log in fresh (and the extension uses the new password too).
    await supabase.auth.signOut();
    window.location.replace("/login?reset=done");
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand">
          <span className="logo">D</span>
          <div>
            <h1>Reset password</h1>
            <p className="muted">Pick a new password for Debrief.</p>
          </div>
        </div>

        {phase === "checking" && <p className="muted">Checking your link…</p>}

        {phase === "error" && (
          <div className="stack">
            {msg && <p className="msg">{msg}</p>}
            <a className="btn primary" href="/login?forgot=1">
              Send a new reset link
            </a>
          </div>
        )}

        {(phase === "ready" || phase === "saving") && (
          <form onSubmit={onSubmit} className="stack">
            <label>
              New password
              <input name="password" type="password" minLength={6} autoComplete="new-password" required />
            </label>
            <label>
              Repeat new password
              <input name="password2" type="password" minLength={6} autoComplete="new-password" required />
            </label>
            {msg && <p className="msg">{msg}</p>}
            <button className="btn primary" disabled={phase === "saving"}>
              {phase === "saving" ? "Saving…" : "Save new password"}
            </button>
            <p className="muted small">Use the new password in the Chrome extension too.</p>
          </form>
        )}
      </div>
    </main>
  );
}
