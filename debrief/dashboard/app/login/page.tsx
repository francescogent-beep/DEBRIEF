"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email")).trim();
    const password = String(f.get("password"));
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    setBusy(true);
    setMsg(null);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: String(f.get("name") || "").trim() }, emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        if (!data.session) {
          setMsg({ text: "Check your inbox to confirm your email, then sign in.", ok: true });
          setMode("signin");
          return;
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      router.push("/");
      router.refresh();
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : "Something went wrong" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand">
          <span className="logo">D</span>
          <div>
            <h1>Debrief</h1>
            <p className="muted">Know why calls die.</p>
          </div>
        </div>
        <form onSubmit={onSubmit} className="stack">
          {mode === "signup" && (
            <label>
              Your name
              <input name="name" autoComplete="name" required />
            </label>
          )}
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input name="password" type="password" minLength={6} autoComplete="current-password" required />
          </label>
          {msg && <p className={`msg ${msg.ok ? "ok" : ""}`}>{msg.text}</p>}
          <button className="btn primary" disabled={busy}>
            {mode === "signin" ? "Sign in" : "Create account"}
          </button>
          <button
            type="button"
            className="btn link"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setMsg(null);
            }}
          >
            {mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
