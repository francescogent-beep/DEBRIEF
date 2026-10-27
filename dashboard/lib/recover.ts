// Sends the "reset your password" email.
// Calls Supabase's /recover endpoint directly (no PKCE), so the link works
// even when it's opened on a different device or browser than the one that
// asked for it. The link lands on /auth/reset with the session in the URL fragment.
export async function sendPasswordReset(email: string, origin: string) {
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/recover?redirect_to=${encodeURIComponent(
    `${origin}/auth/reset`
  )}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (res.ok) return;
  const data = await res.json().catch(() => ({}));
  if (res.status === 429)
    throw new Error("Too many reset emails were sent in the last hour. Try again later, or ask your manager.");
  throw new Error(data.msg || data.error_description || data.message || "Couldn't send the reset email");
}
