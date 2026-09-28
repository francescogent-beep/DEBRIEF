import { loadSession, currentUser, signIn, signUp, signOut, db, ApiError } from "./api.js";
import { DASHBOARD_URL, SUPABASE_ANON_KEY } from "./config.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const WS_KEY = "debrief.workspace";
const QUEUE_KEY = "debrief.queue";

const state = {
  memberships: [],       // [{ role, workspace: { id, name } }]
  wsId: null,
  options: { outcome: [], stage: [], objection: [] },
  byId: new Map(),
  logs: [],              // today's logs (newest first)
  draft: null,           // { outcome, stage, objection, note }
  step: "outcome",       // outcome | stage | objection
  energy: null,
  authMode: "signin",
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
};

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
function show(screen) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== `screen-${screen}`;
}

function message(target, text, ok = false) {
  const m = $(target);
  m.textContent = text || "";
  m.hidden = !text;
  m.classList.toggle("ok", ok);
}

let toastTimer;
function toast(text, undoFn) {
  $("#toast-text").textContent = text;
  const undo = $("#toast-undo");
  undo.hidden = !undoFn;
  undo.onclick = undoFn ? () => { hideToast(); undoFn(); } : null;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, undoFn ? 6000 : 2500);
}
function hideToast() { $("#toast").hidden = true; }

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  if (SUPABASE_ANON_KEY.startsWith("PASTE_")) {
    show("auth");
    message("#auth-msg", "Setup needed: add your Supabase anon key in config.js, then reload the extension.");
    $("#auth-submit").disabled = true;
    return;
  }
  await loadSession();
  if (!currentUser()) return show("auth");
  await afterLogin();
}

async function afterLogin() {
  try {
    const uid = currentUser().id;
    state.memberships = await db.select(
      "memberships",
      `select=role,workspace:workspaces(id,name)&user_id=eq.${uid}&active=eq.true`
    );
  } catch (e) {
    if (e.status === 401) return show("auth");
    show("auth");
    return message("#auth-msg", e.message);
  }
  if (!state.memberships.length) {
    $("#join-back").hidden = true;
    return show("join");
  }
  const saved = (await chrome.storage.local.get(WS_KEY))[WS_KEY];
  const ids = state.memberships.map((m) => m.workspace.id);
  state.wsId = ids.includes(saved) ? saved : ids[0];
  renderWorkspaceSelect();
  show("main");
  await loadWorkspace();
}

function renderWorkspaceSelect() {
  const sel = $("#ws-select");
  sel.replaceChildren(
    ...state.memberships.map((m) =>
      el("option", { value: m.workspace.id, textContent: m.workspace.name, selected: m.workspace.id === state.wsId })
    )
  );
  sel.disabled = state.memberships.length < 2;
  const isManager = state.memberships.find((m) => m.workspace.id === state.wsId)?.role === "manager";
  $("#menu-dashboard").hidden = !(isManager && DASHBOARD_URL);
}

async function loadWorkspace() {
  await chrome.storage.local.set({ [WS_KEY]: state.wsId });
  const opts = await db.select(
    "options",
    `select=id,kind,label,is_success,sort&workspace_id=eq.${state.wsId}&active=eq.true&order=sort.asc`
  );
  state.options = { outcome: [], stage: [], objection: [] };
  state.byId = new Map();
  for (const o of opts) {
    state.options[o.kind].push(o);
    state.byId.set(o.id, o);
  }
  resetDraft();
  await flushQueue();
  await loadToday();
  await loadEod();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
$("#auth-toggle").addEventListener("click", () => {
  state.authMode = state.authMode === "signin" ? "signup" : "signin";
  const up = state.authMode === "signup";
  $("#name-field").hidden = !up;
  $("#auth-submit").textContent = up ? "Create account" : "Sign in";
  $("#auth-toggle").textContent = up ? "Already have an account? Sign in" : "New here? Create an account";
  message("#auth-msg", "");
});

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const email = f.get("email").trim();
  const password = f.get("password");
  const btn = $("#auth-submit");
  btn.disabled = true;
  message("#auth-msg", "");
  try {
    if (state.authMode === "signup") {
      const { needsConfirmation } = await signUp(email, password, f.get("name").trim());
      if (needsConfirmation) {
        message("#auth-msg", "Check your inbox to confirm your email, then sign in here.", true);
        $("#auth-toggle").click();
        return;
      }
    } else {
      await signIn(email, password);
    }
    e.target.reset();
    await afterLogin();
  } catch (err) {
    message("#auth-msg", err.message);
  } finally {
    btn.disabled = false;
  }
});

async function doSignOut() {
  await signOut();
  state.memberships = [];
  state.wsId = null;
  show("auth");
}
for (const b of document.querySelectorAll(".signout")) b.addEventListener("click", doSignOut);

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------
$("#join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = new FormData(e.target).get("code").trim().toUpperCase();
  message("#join-msg", "");
  try {
    const wsId = await db.rpc("join_workspace", { p_code: code });
    await chrome.storage.local.set({ [WS_KEY]: wsId });
    e.target.reset();
    await afterLogin();
    toast("You're in 🎉");
  } catch (err) {
    message("#join-msg", err.message);
  }
});
$("#join-back").addEventListener("click", () => show("main"));

// ---------------------------------------------------------------------------
// Menu & workspace switch
// ---------------------------------------------------------------------------
$("#menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#menu").hidden = !$("#menu").hidden;
});
document.addEventListener("click", () => ($("#menu").hidden = true));
$("#menu").addEventListener("click", async (e) => {
  const action = e.target.dataset.action;
  if (action === "join") { $("#join-back").hidden = false; show("join"); }
  if (action === "dashboard") chrome.tabs.create({ url: DASHBOARD_URL });
  if (action === "signout") doSignOut();
});
$("#ws-select").addEventListener("change", async (e) => {
  state.wsId = e.target.value;
  renderWorkspaceSelect();
  await loadWorkspace();
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function switchTab(name) {
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.tab === name);
  $("#tab-log").hidden = name !== "log";
  $("#tab-eod").hidden = name !== "eod";
  if (name === "eod") renderEodSummary();
}
for (const t of document.querySelectorAll(".tab")) t.addEventListener("click", () => switchTab(t.dataset.tab));

// ---------------------------------------------------------------------------
// Logging flow: outcome → (stage) → (objection + note) → save
// ---------------------------------------------------------------------------
function resetDraft() {
  state.draft = { outcome: null, stage: null, objection: null, note: "" };
  setStep("outcome");
}

function setStep(step) {
  state.step = step;
  $("#step-outcome").hidden = step !== "outcome";
  $("#step-stage").hidden = step !== "stage";
  $("#step-objection").hidden = step !== "objection";
  if (step === "outcome") renderOutcomes();
  if (step === "stage") renderStages();
  if (step === "objection") renderObjections();
}

function optButton(opt, index, onClick, extraClass = "") {
  const b = el("button", { className: `opt ${extraClass}`.trim(), type: "button" });
  if (index < 9) b.append(el("kbd", { textContent: String(index + 1) }));
  b.append(opt.label);
  b.addEventListener("click", onClick);
  return b;
}

function renderOutcomes() {
  // Put the success outcome ("Booked") first and full-width.
  const list = [...state.options.outcome].sort((a, b) => Number(b.is_success) - Number(a.is_success));
  state.orderedOutcomes = list;
  $("#outcomes").replaceChildren(
    ...list.map((o, i) => optButton(o, i, () => chooseOutcome(o), o.is_success ? "success" : ""))
  );
}

function chooseOutcome(o) {
  state.draft.outcome = o;
  if (o.is_success) return saveLog();          // Booked = one click.
  $("#chosen-outcome").textContent = o.label;
  setStep("stage");
}

function renderStages() {
  $("#stages").replaceChildren(
    ...state.options.stage.map((s, i) => optButton(s, i, () => chooseStage(s)))
  );
}

function chooseStage(s) {
  state.draft.stage = s;
  $("#chosen-stage").textContent = s ? s.label : state.draft.outcome.label;
  setStep("objection");
}
$("#skip-stage").addEventListener("click", () => chooseStage(null));

function renderObjections() {
  $("#objections").replaceChildren(
    ...state.options.objection.map((o) => {
      const c = el("button", { className: "chip", type: "button", textContent: o.label });
      c.classList.toggle("on", state.draft.objection?.id === o.id);
      c.addEventListener("click", () => {
        state.draft.objection = state.draft.objection?.id === o.id ? null : o;
        renderObjections();
      });
      return c;
    })
  );
  $("#note").value = state.draft.note;
}
$("#note").addEventListener("input", (e) => (state.draft.note = e.target.value));
$("#save-log").addEventListener("click", () => saveLog());
$("#cancel-log").addEventListener("click", () => resetDraft());

async function saveLog() {
  const d = state.draft;
  const row = {
    workspace_id: state.wsId,
    rep_id: currentUser().id,
    outcome_id: d.outcome.id,
    stage_id: d.stage?.id || null,
    objection_id: d.objection?.id || null,
    note: d.note.trim() || null,
    created_at: new Date().toISOString(),
  };
  resetDraft();

  // Optimistic: show it immediately.
  const temp = { ...row, id: `temp-${Date.now()}`, pending: true };
  state.logs.unshift(temp);
  renderToday();

  try {
    const [saved] = await db.insert("call_logs", row);
    Object.assign(temp, saved, { pending: false });
    renderToday();
    const label = state.byId.get(row.outcome_id)?.label || "Logged";
    toast(`${label} ✓`, () => deleteLog(saved.id));
  } catch (err) {
    if (err instanceof ApiError && err.status && err.status < 500 && err.status !== 401) {
      state.logs = state.logs.filter((l) => l !== temp);
      renderToday();
      toast(`Couldn't save: ${err.message}`);
    } else {
      // Network hiccup — keep it and retry later.
      await enqueue(row);
      toast("Saved offline — will sync automatically");
    }
  }
}

async function deleteLog(id) {
  try {
    await db.remove("call_logs", `id=eq.${id}`);
    state.logs = state.logs.filter((l) => l.id !== id);
    renderToday();
    toast("Removed");
  } catch (err) {
    toast(`Couldn't remove: ${err.message}`);
  }
}

// Offline queue ---------------------------------------------------------------
async function enqueue(row) {
  const q = (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] || [];
  q.push(row);
  await chrome.storage.local.set({ [QUEUE_KEY]: q });
}
async function flushQueue() {
  const q = (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] || [];
  if (!q.length) return;
  const left = [];
  for (const row of q) {
    try { await db.insert("call_logs", row); }
    catch (e) { if (!(e instanceof ApiError) || e.status >= 500 || !e.status) left.push(row); }
  }
  await chrome.storage.local.set({ [QUEUE_KEY]: left });
}
setInterval(() => { if (currentUser()) flushQueue().catch(() => {}); }, 60_000);

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function loadToday() {
  state.logs = await db.select(
    "call_logs",
    `select=id,outcome_id,stage_id,objection_id,note,created_at&workspace_id=eq.${state.wsId}` +
      `&rep_id=eq.${currentUser().id}&created_at=gte.${encodeURIComponent(startOfToday().toISOString())}` +
      `&order=created_at.desc&limit=1000`
  );
  renderToday();
}

function counts() {
  const convos = state.logs.length;
  const booked = state.logs.filter((l) => state.byId.get(l.outcome_id)?.is_success).length;
  return { convos, booked };
}

function renderToday() {
  const { convos, booked } = counts();
  $("#stat-convos").textContent = convos;
  $("#stat-booked").textContent = booked;
  $("#stat-rate").textContent = convos ? `${Math.round((booked / convos) * 100)}%` : "–";

  const recent = state.logs.slice(0, 8);
  $("#recent-empty").hidden = recent.length > 0;
  const editableSince = Date.now() - 15 * 60 * 1000;
  $("#recent-list").replaceChildren(
    ...recent.map((l) => {
      const o = state.byId.get(l.outcome_id);
      const bits = [state.byId.get(l.stage_id)?.label, state.byId.get(l.objection_id)?.label].filter(Boolean);
      const li = el(
        "li",
        {},
        el("span", {
          className: "time",
          textContent: new Date(l.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        }),
        el(
          "span",
          { className: "what", title: [o?.label, ...bits, l.note].filter(Boolean).join(" · ") },
          el("b", { className: o?.is_success ? "good" : "", textContent: o?.label || "?" }),
          bits.length ? ` · ${bits.join(" · ")}` : ""
        )
      );
      if (l.pending) li.append(el("span", { className: "pending", textContent: "saving…" }));
      else if (new Date(l.created_at).getTime() > editableSince) {
        const del = el("button", { className: "del", title: "Remove", textContent: "×" });
        del.addEventListener("click", () => deleteLog(l.id));
        li.append(del);
      }
      return li;
    })
  );
}

// ---------------------------------------------------------------------------
// End of day
// ---------------------------------------------------------------------------
function top(field) {
  const tally = new Map();
  for (const l of state.logs) if (l[field]) tally.set(l[field], (tally.get(l[field]) || 0) + 1);
  const [id, n] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  return id ? `${state.byId.get(id)?.label} (${n})` : "—";
}

function renderEodSummary() {
  const { convos, booked } = counts();
  $("#eod-summary").replaceChildren(
    el(
      "dl",
      {},
      el("dt", { textContent: "Conversations" }), el("dd", { textContent: convos }),
      el("dt", { textContent: "Booked" }), el("dd", { textContent: booked }),
      el("dt", { textContent: "Most died at" }), el("dd", { textContent: top("stage_id") }),
      el("dt", { textContent: "Top objection" }), el("dd", { textContent: top("objection_id") })
    )
  );
}

function renderEnergy() {
  $("#energy-row").replaceChildren(
    ...[1, 2, 3, 4, 5].map((n) => {
      const b = el("button", { type: "button", textContent: n, title: ["Drained", "Low", "OK", "Good", "On fire"][n - 1] });
      b.classList.toggle("on", state.energy === n);
      b.addEventListener("click", () => { state.energy = n; renderEnergy(); });
      return b;
    })
  );
}

async function loadEod() {
  const form = $("#eod-form");
  form.reset();
  state.energy = null;
  message("#eod-msg", "");
  $("#eod-submit").textContent = "Sign off the day";
  const [existing] = await db.select(
    "eods",
    `select=*&workspace_id=eq.${state.wsId}&rep_id=eq.${currentUser().id}&day=eq.${localDay()}`
  );
  if (existing) {
    form.went_well.value = existing.went_well || "";
    form.improve.value = existing.improve || "";
    form.blockers.value = existing.blockers || "";
    state.energy = existing.energy;
    $("#eod-submit").textContent = "Update sign-off";
  }
  renderEnergy();
  renderEodSummary();
}

$("#eod-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (!state.energy) return message("#eod-msg", "Pick your energy level (1–5).");
  const { convos, booked } = counts();
  const btn = $("#eod-submit");
  btn.disabled = true;
  try {
    await db.upsert(
      "eods",
      {
        workspace_id: state.wsId,
        rep_id: currentUser().id,
        day: localDay(),
        conversations: convos,
        booked,
        went_well: f.went_well.value.trim() || null,
        improve: f.improve.value.trim() || null,
        blockers: f.blockers.value.trim() || null,
        energy: state.energy,
        updated_at: new Date().toISOString(),
      },
      "workspace_id,rep_id,day"
    );
    message("#eod-msg", "Day signed off. Nice work 👋", true);
    btn.textContent = "Update sign-off";
  } catch (err) {
    message("#eod-msg", err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts (when the panel is focused)
// ---------------------------------------------------------------------------
document.addEventListener("keydown", (e) => {
  if ($("#screen-main").hidden || $("#tab-log").hidden) return;
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);

  if (e.key === "Escape") { resetDraft(); document.activeElement?.blur(); return; }
  if (state.step === "objection" && e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    return saveLog();
  }
  if (typing) return;

  const n = Number(e.key);
  if (n >= 1 && n <= 9) {
    if (state.step === "outcome" && state.orderedOutcomes?.[n - 1]) chooseOutcome(state.orderedOutcomes[n - 1]);
    else if (state.step === "stage" && state.options.stage[n - 1]) chooseStage(state.options.stage[n - 1]);
  }
  if (state.step === "stage" && e.key.toLowerCase() === "s") chooseStage(null);
});

boot();
