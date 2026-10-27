import { loadSession, currentUser, signIn, signUp, signOut, db, ApiError, handoffUrl } from "./api.js";
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
  clients: [],           // active clients (sub-accounts) in this workspace
  clientId: null,        // who the rep is calling for right now
  dialClients: [],       // client ids shown in the EOD dials section
  manualDials: new Set(), // clients the rep added to the dials section by hand
  breakOpen: null,       // { id, started_at } while the rep is on a break
  breaksToday: [],       // [{ s, e }] ms — breaks in this shift (for gap maths)
  dayStart: null,        // ISO time the rep pressed "Start my day" this shift
};
const CLIENT_KEY = (ws) => `debrief.client.${ws}`;
const NO_CLIENT = "none";

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
      `select=role,workspace:workspaces(id,name,min_dials,min_booked)&user_id=eq.${uid}&active=eq.true`
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
  $("#menu-mystats").hidden = !DASHBOARD_URL;
  $("#mystats-btn").hidden = !DASHBOARD_URL;
}

async function loadWorkspace() {
  await chrome.storage.local.set({ [WS_KEY]: state.wsId });
  const ws = state.memberships.find((m) => m.workspace.id === state.wsId)?.workspace || {};
  state.targets = { min_dials: ws.min_dials ?? null, min_booked: ws.min_booked ?? null };
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
  state.clients = await db.select(
    "clients",
    `select=id,name,sort&workspace_id=eq.${state.wsId}&active=eq.true&order=sort.asc,name.asc`
  );
  const savedClient = (await chrome.storage.local.get(CLIENT_KEY(state.wsId)))[CLIENT_KEY(state.wsId)];
  state.clientId = state.clients.some((c) => c.id === savedClient) ? savedClient : null;
  renderClientBar();
  resetDraft();
  await flushQueue();
  await loadToday();
  await loadBreak();
  processAway().catch(() => {});
  await loadEod();
}

// ---------------------------------------------------------------------------
// Breaks: Pause / Resume. Break time is taken out of "time between pick-ups"
// in the reports, and managers see "On break" on the dashboard.
// ---------------------------------------------------------------------------
const BREAK_MAX_MS = 2 * 60 * 60 * 1000; // a forgotten break counts for at most 2h

async function loadBreak() {
  state.breakOpen = null;
  state.breaksToday = [];
  try {
    const rows = await db.select(
      "breaks",
      `select=started_at,ended_at&workspace_id=eq.${state.wsId}&rep_id=eq.${currentUser().id}` +
        `&started_at=gt.${encodeURIComponent(new Date(shiftStart().getTime() - BREAK_MAX_MS).toISOString())}`
    );
    state.breaksToday = rows
      .filter((b) => b.ended_at)
      .map((b) => ({ s: Date.parse(b.started_at), e: Date.parse(b.ended_at) }));
  } catch { /* optional */ }
  try {
    const [open] = await db.select(
      "breaks",
      `select=id,started_at&workspace_id=eq.${state.wsId}&rep_id=eq.${currentUser().id}` +
        `&ended_at=is.null&order=started_at.desc&limit=1`
    );
    if (open && Date.now() - new Date(open.started_at).getTime() > BREAK_MAX_MS) {
      // Forgotten break: close it at the 2h cap.
      const end = new Date(new Date(open.started_at).getTime() + BREAK_MAX_MS).toISOString();
      await db.update("breaks", `id=eq.${open.id}`, { ended_at: end }).catch(() => {});
    } else if (open) {
      state.breakOpen = open;
    }
  } catch { /* breaks are optional — never block logging */ }
  renderBreak();
}

async function startBreak() {
  if (state.breakOpen) return;
  const started_at = new Date().toISOString();
  const b = { id: null, started_at };
  state.breakOpen = b;
  renderBreak();
  b.saving = db
    .insert("breaks", { workspace_id: state.wsId, rep_id: currentUser().id, started_at })
    .then(([row]) => { b.id = row.id; })
    .catch((err) => {
      if (state.breakOpen === b) state.breakOpen = null;
      renderBreak();
      toast(`Couldn't start the break: ${err.message}`);
    });
}

async function endBreak({ quiet = false } = {}) {
  const b = state.breakOpen;
  if (!b) return;
  state.breakOpen = null;
  renderBreak();
  const ended_at = new Date().toISOString();
  const mins = Math.max(1, Math.round((Date.parse(ended_at) - Date.parse(b.started_at)) / 60000));
  try {
    if (b.saving) await b.saving;
    if (b.id) await db.update("breaks", `id=eq.${b.id}`, { ended_at });
    state.breaksToday.push({ s: Date.parse(b.started_at), e: Date.parse(ended_at) });
    if (!quiet) toast(`Back to it 💪 Break: ${mins} min`);
  } catch (err) {
    toast(`Couldn't end the break: ${err.message}`);
  }
}

function toggleBreak() {
  return state.breakOpen ? endBreak() : startBreak();
}

// ---------------------------------------------------------------------------
// Question card — one question at a time.
// ---------------------------------------------------------------------------
const askQueue = [];
let askCurrent = null;
let askTimer = null;

function ask(q) {
  // q: { key, text, buttons: [{ label, primary?, run }], timeoutMs?, onTimeout? }
  if (askCurrent?.key === q.key || askQueue.some((x) => x.key === q.key)) return;
  askQueue.push(q);
  if (!askCurrent) nextAsk();
}
function nextAsk() {
  clearTimeout(askTimer);
  askCurrent = askQueue.shift() || null;
  const card = $("#ask-card");
  if (!askCurrent) { card.hidden = true; return; }
  const q = askCurrent;
  $("#ask-text").textContent = q.text;
  const box = $("#ask-buttons");
  box.replaceChildren(
    ...q.buttons.map((b) =>
      el("button", {
        className: `btn small ${b.primary ? "primary" : "ghost"}`,
        type: "button",
        textContent: b.label,
        onclick: async () => { closeAsk(q); await b.run(); },
      })
    )
  );
  card.hidden = false;
  if (q.timeoutMs) askTimer = setTimeout(async () => { closeAsk(q); await q.onTimeout?.(); }, q.timeoutMs);
}
function closeAsk(q) {
  if (askCurrent !== q) return;
  askCurrent = null;
  nextAsk();
}
// Called when the rep logs a pick-up: any open question resolves via its onLog.
async function resolveAsksOnLog() {
  const all = [askCurrent, ...askQueue.splice(0)].filter(Boolean);
  askCurrent = null;
  nextAsk();
  for (const q of all) await q.onLog?.();
}

const mins = (ms) => Math.max(1, Math.round(ms / 60000));
const overlapMs = (s, e) =>
  state.breaksToday.reduce((a, b) => a + Math.max(0, Math.min(b.e, e) - Math.max(b.s, s)), 0);

async function saveBreak(startMs, endMs, source) {
  const row = {
    workspace_id: state.wsId,
    rep_id: currentUser().id,
    started_at: new Date(startMs).toISOString(),
    ended_at: new Date(endMs).toISOString(),
    source,
  };
  const [saved] = await db.insert("breaks", row);
  state.breaksToday.push({ s: startMs, e: endMs, id: saved.id });
  return saved;
}
async function undoBreak(id) {
  try {
    await db.remove("breaks", `id=eq.${id}`);
    state.breaksToday = state.breaksToday.filter((b) => b.id !== id);
    toast("OK, not counted as a break");
  } catch (err) {
    toast(`Couldn't undo: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 1) Long gap: after a pick-up that came 30+ min after the previous one
//    (not counting breaks), ask whether the rep was on a break or dialing.
// ---------------------------------------------------------------------------
const GAP_ASK_MIN = 30;

function askAboutGap(savedLog, prevAt, fromStart = false) {
  const end = Date.parse(savedLog.created_at);
  const gapMs = end - prevAt - overlapMs(prevAt, end);
  if (gapMs < GAP_ASK_MIN * 60000) return;
  const gap = mins(gapMs);
  const asBreak = (m) => async () => {
    const dur = Math.min(m * 60000, gapMs);
    try {
      const b = await saveBreak(prevAt, prevAt + dur, "gap");
      toast(`Saved: ${mins(dur)} min break`, () => undoBreak(b.id));
    } catch (err) { toast(`Couldn't save: ${err.message}`); }
  };
  const options = [15, 30, 45, 60].filter((m) => m < gap - 2);
  ask({
    key: `gap-${savedLog.id}`,
    text: fromStart
      ? `${gap} min since you started your day. Were you on a break?`
      : `${gap} min since your previous pick-up. Were you on a break?`,
    buttons: [
      {
        label: "No, I was dialing",
        primary: true,
        run: async () => {
          try {
            await db.update("call_logs", `id=eq.${savedLog.id}`, { gap_confirmed: true });
            toast("Got it — counted as dialing time");
          } catch (err) { toast(`Couldn't save: ${err.message}`); }
        },
      },
      ...options.map((m) => ({ label: `Break ${m}m`, run: asBreak(m) })),
      { label: `Break, all ${gap}m`, run: asBreak(gap) },
    ],
    timeoutMs: 10 * 60000, // unanswered → shows as an unexplained gap for managers
  });
}

// ---------------------------------------------------------------------------
// 2) Away detection (extension only): the background worker queues periods
//    with no activity (10+ min) or a locked screen. Locked = break. Idle =
//    ask, because a long call can look idle; logging a pick-up = was on a call.
// ---------------------------------------------------------------------------
const PENDING_KEY = "debrief.awayPending";
const HAS_IDLE = typeof chrome !== "undefined" && !!chrome.idle;

async function processAway() {
  if (!HAS_IDLE || !state.wsId || !currentUser()) return;
  const list = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] || [];
  if (!list.length) return;
  await chrome.storage.local.set({ [PENDING_KEY]: [] });
  const floor = shiftStart().getTime();
  for (const a of list) {
    const start = Math.max(a.start, floor);
    const end = a.end;
    if (end - start < 5 * 60000) continue;
    if (state.breakOpen && Date.parse(state.breakOpen.started_at) < end) continue; // already on a manual break
    if (overlapMs(start, end) > (end - start) / 2) continue; // already covered
    const loggedDuring = state.logs.some((l) => {
      const t = Date.parse(l.created_at);
      return t > start && t < end;
    });
    if (loggedDuring) continue;
    const away = mins(end - start);
    const save = async (note) => {
      try {
        const b = await saveBreak(start, end, "idle");
        toast(note || `Away ${away} min — counted as a break`, () => undoBreak(b.id));
      } catch (err) { toast(`Couldn't save the break: ${err.message}`); }
    };
    if (a.locked) {
      await save(`Welcome back 👋 Screen was locked ${away} min — counted as a break`);
      continue;
    }
    // Panel was closed while they were away and it's long past: save it, with Undo.
    if (Date.now() - end > 3 * 60000) {
      await save(`You were away ${away} min — counted as a break`);
      continue;
    }
    ask({
      key: `away-${a.start}`,
      text: `Welcome back 👋 No activity on this computer for ${away} min. Were you on a break?`,
      buttons: [
        { label: "Yes, break", primary: true, run: () => save(`Saved: ${away} min break`) },
        { label: "No, I was on a call", run: async () => toast("Got it — not a break") },
      ],
      timeoutMs: 3 * 60000,
      onTimeout: () => save(),
      onLog: async () => {}, // logging a pick-up first = they were on a call
    });
  }
}
if (HAS_IDLE && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[PENDING_KEY]?.newValue?.length) processAway().catch(() => {});
  });
}

function renderBreak() {
  const on = !!state.breakOpen;
  $("#break-banner").hidden = !on;
  $("#break-btn").hidden = on;
  $("#screen-main").classList.toggle("on-break", on);
  if (on) {
    const secs = Math.max(0, Math.floor((Date.now() - Date.parse(state.breakOpen.started_at)) / 1000));
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    $("#break-time").textContent = h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  }
}
setInterval(() => { if (state.breakOpen) renderBreak(); }, 1000);
$("#break-btn").addEventListener("click", () => startBreak());
$("#break-resume").addEventListener("click", () => endBreak());

// ---------------------------------------------------------------------------
// Clients: who the rep is calling for. Required when the workspace has any.
// ---------------------------------------------------------------------------
const clientName = (id) => state.clients.find((c) => c.id === id)?.name || (id ? "Other client" : "No client");
const needsClient = () => state.clients.length > 0 && !state.clientId;

function renderClientBar() {
  const bar = $("#client-bar");
  bar.hidden = state.clients.length === 0;
  const sel = $("#client-select");
  sel.replaceChildren(
    el("option", { value: "", textContent: "Choose client…", disabled: true, selected: !state.clientId }),
    ...state.clients.map((c) => el("option", { value: c.id, textContent: c.name, selected: c.id === state.clientId }))
  );
  bar.classList.toggle("empty", needsClient());
  $("#outcomes").classList.toggle("locked", needsClient());
  $("#client-needed").hidden = true;
}

$("#client-select").addEventListener("change", async (e) => {
  state.clientId = e.target.value || null;
  e.target.blur(); // give the keyboard back to the 1–9 shortcuts
  await chrome.storage.local.set({ [CLIENT_KEY(state.wsId)]: state.clientId });
  renderClientBar();
  toast(`Calling for ${clientName(state.clientId)}`);
});

function promptClient() {
  $("#client-needed").hidden = false;
  $("#client-select").focus();
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
  if (action === "mystats") openMyStats();
  if (action === "signout") doSignOut();
});
async function openMyStats() {
  const next = `/w/${state.wsId}/me`;
  try {
    chrome.tabs.create({ url: await handoffUrl(DASHBOARD_URL, next) });
  } catch {
    chrome.tabs.create({ url: `${DASHBOARD_URL}${next}` });
  }
}
$("#mystats-btn").addEventListener("click", openMyStats);

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
  if (name === "eod") {
    // Rebuild the dials boxes from the clients actually worked this shift,
    // keeping any box the rep added by hand or already typed into.
    const typed = readDials().byClient;
    const keep = state.dialClients.filter((id) => state.manualDials.has(id) || typed[id] != null);
    state.dialClients = [...new Set([...defaultDialClients(), ...keep])];
    renderDials();
    renderEodSummary();
  }
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
  if (needsClient()) return promptClient();
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
  // Logging a call means the break is over, and answers any "were you away?" question.
  if (state.breakOpen) await endBreak({ quiet: true });
  await resolveAsksOnLog();
  const prevLog = state.logs.find((l) => !l.pending);
  const firstOfShift = !prevLog;
  const startAt = state.dayStart ? Date.parse(state.dayStart) : null;
  const prevAt = prevLog ? Date.parse(prevLog.created_at) : startAt;
  const d = state.draft;
  const row = {
    workspace_id: state.wsId,
    rep_id: currentUser().id,
    outcome_id: d.outcome.id,
    stage_id: d.stage?.id || null,
    objection_id: d.objection?.id || null,
    note: d.note.trim() || null,
    client_id: state.clientId || null,
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
    if (prevAt) askAboutGap(saved, prevAt, !prevLog);
    else if (firstOfShift) askWhenStarted(saved);
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
// Today = the current shift. A shift starts right after the rep's last EOD
// sign-off (so a shift can run past midnight), and never looks back more
// than 18 hours in case someone forgot to sign off.
// ---------------------------------------------------------------------------
const SHIFT_MAX_MS = 18 * 60 * 60 * 1000;

function dayOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shiftStart() {
  const floor = Date.now() - SHIFT_MAX_MS;
  const last = state.lastEod ? new Date(state.lastEod.updated_at).getTime() : 0;
  return new Date(Math.max(floor, last));
}

// The calendar day this shift belongs to: the day its first call was logged.
function shiftDay() {
  const first = state.logs[state.logs.length - 1];
  return dayOf(first ? new Date(first.created_at) : new Date());
}

async function loadToday() {
  const me = currentUser().id;
  const [last] = await db.select(
    "eods",
    `select=day,dials,dials_by_client,booked,conversations,went_well,improve,blockers,energy,updated_at` +
      `&workspace_id=eq.${state.wsId}&rep_id=eq.${me}&order=updated_at.desc&limit=1`
  );
  state.lastEod = last || null;
  try {
    const [st] = await db.select(
      "day_starts",
      `select=started_at&workspace_id=eq.${state.wsId}&rep_id=eq.${me}` +
        `&started_at=gt.${encodeURIComponent(shiftStart().toISOString())}&order=started_at.desc&limit=1`
    );
    state.dayStart = st?.started_at || null;
  } catch { state.dayStart = null; }
  state.logs = await db.select(
    "call_logs",
    `select=id,outcome_id,stage_id,objection_id,client_id,note,created_at&workspace_id=eq.${state.wsId}` +
      `&rep_id=eq.${me}&created_at=gt.${encodeURIComponent(shiftStart().toISOString())}` +
      `&order=created_at.desc&limit=1000`
  );
  renderToday();
}

function counts() {
  const convos = state.logs.length;
  const booked = state.logs.filter((l) => state.byId.get(l.outcome_id)?.is_success).length;
  return { convos, booked };
}

function renderStart() {
  const started = !!state.dayStart || state.logs.length > 0;
  $("#start-row").hidden = started;
  const lbl = $("#started-label");
  const t = state.dayStart || state.logs[state.logs.length - 1]?.created_at;
  lbl.hidden = !t;
  if (t) lbl.textContent = `Started ${new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

async function saveDayStart(startedAtMs, source) {
  const row = {
    workspace_id: state.wsId,
    rep_id: currentUser().id,
    day: dayOf(new Date(startedAtMs)),
    started_at: new Date(startedAtMs).toISOString(),
    source,
  };
  await db.upsert("day_starts", row, "workspace_id,rep_id,day");
  state.dayStart = row.started_at;
  renderStart();
}

async function startDay() {
  if (state.dayStart) return;
  const now = Date.now();
  state.dayStart = new Date(now).toISOString(); // optimistic
  renderStart();
  try {
    await saveDayStart(now, "button");
    toast("Day started 🚀 Good luck!");
  } catch (err) {
    state.dayStart = null;
    renderStart();
    toast(`Couldn't start the day: ${err.message}`);
  }
}
$("#start-btn").addEventListener("click", startDay);

// First pick-up of the shift without "Start my day": ask when dialing started.
function askWhenStarted(firstLog) {
  const logged = Date.parse(firstLog.created_at);
  const floor = Math.max(shiftStart().getTime(), logged - 12 * 3600000);
  const options = [15, 30, 60, 120].filter((m) => logged - m * 60000 >= floor);
  const set = (m, source) => async () => {
    try {
      await saveDayStart(logged - m * 60000, source);
      if (m > 0) toast(`Got it — you started dialing ${m >= 60 ? `${m / 60}h` : `${m} min`} before this pick-up`);
    } catch (err) { toast(`Couldn't save: ${err.message}`); }
  };
  ask({
    key: `start-${firstLog.id}`,
    text: "First pick-up of the day 👋 When did you start dialing?",
    buttons: [
      { label: "Just now", primary: true, run: set(0, "asked") },
      ...options.map((m) => ({ label: m >= 60 ? `${m / 60}h ago` : `${m} min ago`, run: set(m, "asked") })),
    ],
    timeoutMs: 10 * 60000,
    onTimeout: set(0, "auto"),
    onLog: set(0, "auto"),
  });
}

function renderToday() {
  renderStart();
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
      if (state.clients.length > 1 && l.client_id) {
        li.insertBefore(el("span", { className: "client", textContent: clientName(l.client_id), title: clientName(l.client_id) }), li.children[1]);
      }
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
// End of day: targets check + sign-off. Signing off closes the day.
// ---------------------------------------------------------------------------
function top(field) {
  const tally = new Map();
  for (const l of state.logs) if (l[field]) tally.set(l[field], (tally.get(l[field]) || 0) + 1);
  const [id, n] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  return id ? `${state.byId.get(id)?.label} (${n})` : "—";
}

function fmtDay(day) {
  return new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

function renderEodSummary() {
  const { convos, booked } = counts();
  $("#eod-summary").replaceChildren(
    el(
      "dl",
      {},
      el("dt", { textContent: "Pick-ups" }), el("dd", { textContent: convos }),
      el("dt", { textContent: "Booked" }), el("dd", { textContent: booked }),
      el("dt", { textContent: "Most died at" }), el("dd", { textContent: top("stage_id") }),
      el("dt", { textContent: "Top objection" }), el("dd", { textContent: top("objection_id") }),
      ...perClientSummary()
    )
  );
  const last = state.lastEod;
  $("#eod-last").hidden = !last;
  if (last) {
    $("#eod-last").textContent =
      `Last sign-off: ${fmtDay(last.day)} · ${last.dials ?? "–"} dials · ${last.booked} booked. ` +
      `Everything since then counts as a new day.`;
  }
  renderChecks();
}

function perClientSummary() {
  if (state.clients.length === 0) return [];
  const by = new Map();
  for (const l of state.logs) {
    const k = l.client_id || NO_CLIENT;
    const v = by.get(k) || { c: 0, b: 0 };
    v.c++;
    if (state.byId.get(l.outcome_id)?.is_success) v.b++;
    by.set(k, v);
  }
  if (by.size < 2) return [];
  return [...by.entries()].flatMap(([k, v]) => [
    el("dt", { textContent: k === NO_CLIENT ? "No client" : clientName(k) }),
    el("dd", { textContent: `${v.c} pick-ups · ${v.b} booked` }),
  ]);
}

// ---- Dials: one box per client worked this shift (or a single box) --------
function defaultDialClients() {
  if (state.clients.length === 0) return [NO_CLIENT];
  const ids = [];
  for (const l of [...state.logs].reverse()) if (l.client_id && !ids.includes(l.client_id)) ids.push(l.client_id);
  if (state.clientId && !ids.includes(state.clientId)) ids.push(state.clientId);
  return ids.length ? ids : [state.clients[0].id];
}

function renderDials(keepValues = true) {
  const prev = keepValues ? readDials().byClient : {};
  const single = state.dialClients.length === 1 && state.dialClients[0] === NO_CLIENT;
  $("#dials-fields").replaceChildren(
    ...state.dialClients.map((id) => {
      const input = el("input", {
        type: "number", inputMode: "numeric", min: 0, max: 5000,
        placeholder: single ? "From WAVV, e.g. 512" : "0",
        value: prev[id] ?? "",
      });
      input.dataset.client = id;
      input.addEventListener("input", renderChecks);
      return el("label", { className: `dial-row${single ? " single" : ""}` },
        single ? "" : el("span", { textContent: clientName(id) }), input);
    })
  );
  const rest = state.clients.filter((c) => !state.dialClients.includes(c.id));
  const add = $("#dials-add");
  add.hidden = single || rest.length === 0;
  add.replaceChildren(
    el("option", { value: "", textContent: "+ Dialed for another client", selected: true }),
    ...rest.map((c) => el("option", { value: c.id, textContent: c.name }))
  );
}

$("#dials-add").addEventListener("change", (e) => {
  if (!e.target.value) return;
  state.dialClients.push(e.target.value);
  state.manualDials.add(e.target.value);
  renderDials();
  $(`#dials-fields input[data-client="${e.target.value}"]`)?.focus();
});

// { total, byClient } — total is null until the rep types at least one number.
function readDials() {
  const byClient = {};
  let total = null;
  for (const input of document.querySelectorAll("#dials-fields input")) {
    if (input.value === "") continue;
    const n = Math.max(0, Math.round(Number(input.value)) || 0);
    byClient[input.dataset.client] = n;
    total = (total ?? 0) + n;
  }
  return { total, byClient };
}

// Daily target = min dials OR min booked (either one is enough).
function targetChecks() {
  const t = state.targets || {};
  const { total: dials } = readDials();
  const { booked } = counts();
  const hasD = t.min_dials != null, hasB = t.min_booked != null;
  const dialsOk = hasD && dials != null && dials >= t.min_dials;
  const bookedOk = hasB && booked >= t.min_booked;
  const hit = (!hasD && !hasB) || dialsOk || bookedOk;
  const pending = !hit && dials == null;
  const rows = [];
  if (hasD) rows.push({ label: `${t.min_dials} dials`, value: dials ?? "—",
    cls: dialsOk ? "ok" : dials == null ? "pending" : hit ? "neutral" : "miss" });
  if (hasB) rows.push({ label: `${t.min_booked} booked`, value: booked,
    cls: bookedOk ? "ok" : hit || pending ? "neutral" : "miss" });
  return { rows, hit, pending, missed: !hit && !pending, dials, hasTargets: hasD || hasB };
}

function renderChecks() {
  const { rows, hit, pending, missed, dials, hasTargets } = targetChecks();
  $("#eod-checks").hidden = !hasTargets;
  $("#checks-title").textContent = rows.length > 1 ? "Daily target — hit either one" : "Daily target";
  $("#eod-checks-list").replaceChildren(
    ...rows.map((r, i) => [
      i > 0 ? el("li", { className: "or" }, el("span", { className: "or-lbl", textContent: "or" })) : null,
      el("li", { className: r.cls },
        el("span", { className: "mark", textContent: r.cls === "ok" ? "✓" : r.cls === "miss" ? "✗" : "○" }),
        el("span", { className: "lbl", textContent: `${r.label}` }),
        el("b", { textContent: r.value })),
    ]).flat().filter(Boolean)
  );
  const status = $("#checks-status");
  status.className = `checks-status ${hit ? "ok" : pending ? "pending" : "miss"}`;
  status.textContent = hit ? "✓ Daily target hit" : pending ? "Enter your dials to check your target" : "✗ Daily target missed";
  const multi = document.querySelectorAll("#dials-fields input").length > 1;
  $("#dials-total").hidden = !multi;
  $("#dials-total").textContent = `Total: ${dials ?? 0}`;
  // A missed target needs a reason.
  $("#eod-form").blockers.required = missed;
  $("#blockers-label").textContent = missed ? "Missed your target — what got in the way?" : "Blockers?";
  $("#blockers-hint").hidden = missed;
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
  $("#eod-form").reset();
  state.dialClients = defaultDialClients();
  state.manualDials = new Set();
  renderDials(false);
  state.energy = null;
  message("#eod-msg", "");
  renderEnergy();
  renderEodSummary();
}


$("#eod-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const { missed, dials } = targetChecks();
  if (dials == null) {
    document.querySelector("#dials-fields input")?.focus();
    return message("#eod-msg", "Enter how many dials you made today.");
  }
  const MIN_TEXT = 15;
  if (f.went_well.value.trim().length < MIN_TEXT) {
    f.went_well.focus();
    return message("#eod-msg", "Tell us how the day went — at least a short sentence.");
  }
  if (f.improve.value.trim().length < MIN_TEXT) {
    f.improve.focus();
    return message("#eod-msg", "Add what you'll improve tomorrow — at least a short sentence.");
  }
  if (missed && f.blockers.value.trim().length < MIN_TEXT) {
    f.blockers.focus();
    return message("#eod-msg", "You missed a target — explain what got in the way (at least a short sentence).");
  }
  if (!state.energy) return message("#eod-msg", "Pick your energy level (1–5).");

  let { convos, booked } = counts();
  let totalDials = dials;
  const byClient = { ...readDials().byClient };
  const day = shiftDay();
  const text = (v) => v.trim() || null;
  const row = {
    workspace_id: state.wsId,
    rep_id: currentUser().id,
    day,
    went_well: text(f.went_well.value),
    improve: text(f.improve.value),
    blockers: text(f.blockers.value),
    energy: state.energy,
  };
  // Second sign-off on the same calendar day (e.g. two short shifts): add them up.
  const prev = state.lastEod;
  if (prev && prev.day === day) {
    convos += prev.conversations || 0;
    booked += prev.booked || 0;
    totalDials += prev.dials || 0;
    const prevBy = prev.dials_by_client || (prev.dials ? { [NO_CLIENT]: prev.dials } : {});
    for (const [k, v] of Object.entries(prevBy)) byClient[k] = (byClient[k] || 0) + (Number(v) || 0);
    for (const k of ["went_well", "improve", "blockers"]) row[k] = row[k] || prev[k];
  }
  Object.assign(row, {
    conversations: convos, booked, dials: totalDials,
    dials_by_client: state.clients.length ? byClient : null,
    updated_at: new Date().toISOString(),
  });

  const btn = $("#eod-submit");
  btn.disabled = true;
  try {
    await endBreak({ quiet: true });
    await db.upsert("eods", row, "workspace_id,rep_id,day");
    await loadToday();       // new shift starts now: counters reset
    await loadEod();
    switchTab("log");
    toast("Day closed 👋 See how you did in ⋯ → My stats");
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

  if (e.key.toLowerCase() === "p" && state.step === "outcome") return toggleBreak();

  const n = Number(e.key);
  if (n >= 1 && n <= 9 && state.step === "outcome" && needsClient()) return promptClient();
  if (n >= 1 && n <= 9) {
    if (state.step === "outcome" && state.orderedOutcomes?.[n - 1]) chooseOutcome(state.orderedOutcomes[n - 1]);
    else if (state.step === "stage" && state.options.stage[n - 1]) chooseStage(state.options.stage[n - 1]);
  }
  if (state.step === "stage" && e.key.toLowerCase() === "s") chooseStage(null);
});

// Version shown at the bottom of the ⋯ menu so reps can check they're up to date.
try {
  $("#menu-version").textContent = `Debrief v${chrome.runtime.getManifest().version}`;
} catch {
  $("#menu-version").textContent = "Debrief (web)";
}

boot();
