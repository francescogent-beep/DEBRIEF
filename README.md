# Debrief

**Know why calls die.** Reps log every answered call in a couple of clicks from a Chrome side panel next to GHL/WAVV, sign off their day, and managers see where calls die, which objections kill them, and what the team is struggling with.

```
debrief/
├── supabase/
│   ├── migrations/20260928000000_init.sql   ← database, security rules, stats
│   └── make-me-owner.sql                    ← one-time: make your account the owner
├── extension/                               ← Chrome extension (reps)
└── dashboard/                               ← Next.js admin dashboard (managers, you)
```

## How it works

| Who | Where | What they do |
|---|---|---|
| **Rep** | Chrome extension side panel | Logs each answered call: outcome → where it died → objection (optional) → note (optional). Signs off the day. |
| **Manager** | Dashboard | Sees their team: dials, pick-ups, bookings, where calls die, top objections, per-rep breakdown, EOD sign-offs, blockers, call notes. Manages invite codes, team, and the option lists. |
| **Owner (you)** | Dashboard | Everything a manager can do, across every workspace. Creates new workspaces (7FigureRia, course students, future clients). |

**Privacy:** no lead data is ever stored — no names, phone numbers or asset amounts. Only outcomes, stages, objections and optional short notes.

---

## Setup (about 20 minutes)

### 1. Database (Supabase)
1. Supabase → **SQL Editor** → New query → paste all of `supabase/migrations/20260928000000_init.sql` → **Run**.
2. Supabase → **Authentication → URL Configuration** → set **Site URL** to your Vercel URL (after step 2).
3. Optional: Authentication → Providers → Email → turn **Confirm email** off during the pilot so reps can start immediately. Leave it on when you sell it.

### 2. Dashboard (Vercel)
1. Push this folder to your GitHub repo `DEBRIEF`.
2. Vercel → **Add New Project** → import the repo → set **Root Directory** to `dashboard`.
3. Add environment variables (Supabase → Project Settings → API):
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://oiatnoefkakgoctqgrzz.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = your **anon / public** key
   - `NEXT_PUBLIC_TEAM_TZ` = `America/New_York` (timezone for "today" and daily charts)
4. Deploy.

### 3. Make yourself the owner and create 7FigureRia
1. Open the dashboard → **Create an account** with your email.
2. Supabase SQL Editor → run `supabase/make-me-owner.sql` with your email filled in.
3. Refresh the dashboard → **New workspace** → name `7FigureRia`, template *Financial advisor setting* → Create.
4. You land on **Team & settings** with a **rep code** and a **manager code**.
   - Give the manager code to the 7Fig managers (they sign up on the dashboard and enter it).
   - Give the rep code to the reps (they enter it in the extension).

### 4. Extension
1. Edit `extension/config.js`: paste the anon key, and your Vercel URL as `DASHBOARD_URL`.
2. Chrome → `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick the `extension` folder.
3. Pin it. Click the icon (or **Alt+D**) to open the side panel.

**Rolling out to 10–15 reps:** publish it on the Chrome Web Store as **Unlisted** ($5 one-time developer fee). Reps install with one link and get updates automatically. Zip the `extension` folder (with your config filled in) and upload it in the Web Store developer dashboard.

---

## Rep quick-start (send this to the team)
1. Install Debrief from the link, pin it, open it next to WAVV (Alt+D).
2. Create an account, enter the team code.
3. After **every answered call**:
   - `1` = Booked (saves instantly)
   - Otherwise pick the outcome, then **where it died** (`1`–`5`, or `S` to skip), tap an objection if there was one, **Enter** to save.
   - Made a mistake? Hit **Undo** or the × next to the call (works for 15 minutes).
4. Going on a break? Hit **⏸ Pause for a break** (or `P`), then **Resume** when back. Logging a call or signing off also ends the break.
5. End of day → **End of day** tab → what worked, what to improve, blockers, energy → **Sign off the day**.

## Default 7FigureRia setup
- **Outcomes:** Booked · Callback · Not interested · Not qualified · Hung up
- **Where it died:** Opener · Pitch · Discovery · Qualification · Booking
- **Objections:** Already have an advisor · Not interested / don't need help · Send me something · Is this a scam? · Too busy / bad time · Need to talk to spouse · Not enough assets · Don't remember signing up · Doesn't want to be sold · Other

Managers can rename, hide or add any of these under **Team & settings**. Hidden options keep their history.

## Clients (sub-accounts)
Managers add the firms reps call for under **Team & settings → Clients**. In the extension, reps pick
**Calling for** before logging; every call is tagged with that client. At end of day they split their dials per
client. The dashboard adds a client filter, a **By client** table and a **Rep × client** report.

## Daily target
A rep is **on target** when they hit the minimum dials **or** the minimum booked (default 500 dials or 5 booked).
If they miss both, the sign-off asks what got in the way.

## Reps who don't use Chrome
- **Edge, Brave, Opera, Arc:** install the extension the same way (they run Chrome extensions).
- **Safari, Firefox, phones:** use the web logger at **`<dashboard URL>/log`**. Same screens, same account, same data.
  - Chrome/Edge: click the install icon in the address bar to open it as its own small app window.
  - Safari (Mac): File → Add to Dock. iPhone: Share → Add to Home Screen.
- The web logger is generated from the extension. After changing anything in `extension/`, run
  `python3 scripts/build-web-logger.py` so both stay identical.

## Spreadsheets & Google Sheets
Dashboard → **⬇ Export / Google Sheets** (or Team & settings → Spreadsheets & Google Sheets):
- **Download CSV** for the Daily report, Rep × client by day, and the Call log (last 90 days).
- **Copy for Google Sheets** gives an `=IMPORTDATA("…")` formula. Paste it in cell A1 of a Google Sheet and it
  refreshes itself about every hour.
- The links contain a secret key. **Reset links** if one leaks; old links and connected sheets stop working.

## My stats (for reps)
Every rep can open **⋯ → 📊 My stats** in the extension (or sign in on the dashboard website with the same email and
password). It shows today's progress toward the target, their numbers vs the team average (pick-ups and booked per day,
book rate, days on target, dials, time between pick-ups), a personal "Your focus" list, where their calls end vs the team,
their best hours and top objections, a day-by-day review with their EOD notes, and every call they logged.
Reps only ever see their own numbers plus anonymous team averages. Managers have the same page for themselves.

## Dashboard vs Reports
- **Dashboard = one day, live.** Today's numbers, who is logging, who is on a break, who has gone quiet (no call in 45+ min), who has signed
  off and hit target, today's blockers, EOD notes and call notes. Use ← Previous day to look back at any single day.
- **Reports = over time.** Everything below.

## Reports
**Reports** (managers and owner). Pick 7, 30 or 90 days and filter by client or rep. Every number is compared with the previous period of the same length.
- **Key findings:** plain-English takeaways (best and weakest calling windows, where calls die, who to coach).
- **When calls get picked up and booked:** weekday × hour heatmap (toggle pick-ups / book rate), best time slots, by hour, by day.
- **Rep scorecard:** pick-ups, booked, book rate and trend, average dials, days on target, EODs done, biggest leak vs the team, top objection.
- **Where each rep loses calls:** stage-by-stage share vs the team, with outliers highlighted.
- **Daily trend, where calls die, top objections.**
- **Time between pick-ups:** break time (Pause button) is taken out. Typical gap, 30+ minute gaps per day, typical gap by hour, and per rep: first/last pick-up and pick-ups per hour.
- **Client results:** funnel per client, biggest drop, best rep, best hour, top objections, plus a **Rep × client** table.

Patterns get reliable at roughly 100+ pick-ups in the range; the page says so when data is thin.

## Roadmap
- **v1.5 (course):** solo mode for students, self-serve workspace creation.
- **v2 (sell):** Stripe billing, AI weekly digest of EOD notes, GHL/WAVV webhook to auto-count dials (connect rate).
