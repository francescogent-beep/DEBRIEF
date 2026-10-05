// Minimal Supabase client (auth + REST + RPC) using fetch.
// No bundler or third-party code needed — keeps the extension tiny and
// Chrome Web Store–friendly.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const SESSION_KEY = "debrief.session";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let session = null;

export async function loadSession() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  session = stored[SESSION_KEY] || null;
  return session;
}

async function saveSession(s) {
  session = s;
  if (s) await chrome.storage.local.set({ [SESSION_KEY]: s });
  else await chrome.storage.local.remove(SESSION_KEY);
}

export function currentUser() {
  return session?.user || null;
}

function normalizeSession(data) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    user: data.user,
  };
}

async function authFetch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data.error_description || data.msg || data.message || "Authentication failed", res.status);
  }
  return data;
}

export async function signIn(email, password) {
  const data = await authFetch("token?grant_type=password", { email, password });
  await saveSession(normalizeSession(data));
  return session.user;
}

// Returns { user, needsConfirmation }
export async function signUp(email, password, fullName) {
  const data = await authFetch("signup", { email, password, data: { full_name: fullName } });
  if (data.access_token) {
    await saveSession(normalizeSession(data));
    return { user: session.user, needsConfirmation: false };
  }
  return { user: data.user || data, needsConfirmation: true };
}

export async function signOut() {
  if (session?.access_token) {
    fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
    }).catch(() => {});
  }
  await saveSession(null);
}

let refreshing = null;
async function refresh() {
  if (!session?.refresh_token) throw new ApiError("Signed out", 401);
  if (!refreshing) {
    refreshing = authFetch("token?grant_type=refresh_token", { refresh_token: session.refresh_token })
      .then((data) => saveSession(normalizeSession(data)))
      .catch(async (e) => {
        await saveSession(null);
        throw new ApiError("Your session expired — please sign in again", 401);
      })
      .finally(() => (refreshing = null));
  }
  return refreshing;
}

async function token() {
  if (!session) throw new ApiError("Signed out", 401);
  if (session.expires_at - 60 < Date.now() / 1000) await refresh();
  return session.access_token;
}

async function request(method, path, { body, headers = {}, retry = true } = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry) {
    await refresh();
    return request(method, path, { body, headers, retry: false });
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.message || data?.hint || `Request failed (${res.status})`, res.status);
  return data;
}

export const db = {
  select: (table, query) => request("GET", `/rest/v1/${table}?${query}`),
  insert: (table, row) =>
    request("POST", `/rest/v1/${table}`, { body: row, headers: { Prefer: "return=representation" } }),
  upsert: (table, row, onConflict) =>
    request("POST", `/rest/v1/${table}?on_conflict=${onConflict}`, {
      body: row,
      headers: { Prefer: "return=representation,resolution=merge-duplicates" },
    }),
  update: (table, query, row) =>
    request("PATCH", `/rest/v1/${table}?${query}`, { body: row, headers: { Prefer: "return=representation" } }),
  remove: (table, query) => request("DELETE", `/rest/v1/${table}?${query}`),
  rpc: (fn, args) => request("POST", `/rest/v1/rpc/${fn}`, { body: args }),
};
