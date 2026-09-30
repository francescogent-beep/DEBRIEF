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
4. End of day → **End of day** tab → what worked, what to improve, blockers, energy → **Sign off the day**.

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

## Spreadsheets & Google Sheets
Dashboard → **⬇ Export / Google Sheets** (or Team & settings → Spreadsheets & Google Sheets):
- **Download CSV** for the Daily report, Rep × client by day, and the Call log (last 90 days).
- **Copy for Google Sheets** gives an `=IMPORTDATA("…")` formula. Paste it in cell A1 of a Google Sheet and it
  refreshes itself about every hour.
- The links contain a secret key. **Reset links** if one leaks; old links and connected sheets stop working.

## Roadmap
- **v1.5 (course):** solo mode for students, self-serve workspace creation.
- **v2 (sell):** Stripe billing, AI weekly digest of EOD notes, GHL/WAVV webhook to auto-count dials (connect rate).
