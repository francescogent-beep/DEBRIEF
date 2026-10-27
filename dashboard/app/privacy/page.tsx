import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy policy · Debrief" };

// Public page (no sign-in), linked from the Chrome Web Store listing.
const OPERATOR = process.env.NEXT_PUBLIC_LEGAL_NAME || "the publisher shown on Debrief's Chrome Web Store page";
const CONTACT = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "info@fgdigitalsystems.com";
const UPDATED = "October 27, 2026";

export default function Privacy() {
  return (
    <main className="page narrow legal">
      <h1 className="page-title">Debrief privacy policy</h1>
      <p className="muted small">Last updated {UPDATED}</p>

      <p>
        Debrief is a call-logging tool for sales and appointment-setting teams: a Chrome extension (and web page) where
        reps log the outcome of answered calls, and a dashboard where their managers review the results. Debrief is
        operated by {OPERATOR}. This page explains what Debrief stores and why.
      </p>

      <h2>What Debrief stores</h2>
      <ul>
        <li>
          <b>Account details:</b> your name, email address and password (passwords are stored hashed by our
          authentication provider; we never see them).
        </li>
        <li>
          <b>Team membership:</b> which team (workspace) you belong to and your role (rep or manager).
        </li>
        <li>
          <b>What you log:</b> for each answered call, the time, the outcome, the stage it ended at, the objection,
          the client you were calling for and any note you type. Debrief does not store the lead&apos;s name, phone
          number or any other details about the person you called, unless you type them into a note.
        </li>
        <li>
          <b>Your workday:</b> when you press Start my day, your breaks (start and end times), your end-of-day sign-off
          (dials, what went well, what to improve, blockers, energy) and your answers to &quot;were you on a
          break?&quot; questions.
        </li>
      </ul>

      <h2>What the extension does on your computer</h2>
      <ul>
        <li>
          It runs only in its own side panel. It does <b>not</b> read, record or change the websites you visit, your
          browsing history, your dialer or your calls.
        </li>
        <li>
          It uses Chrome&apos;s <b>idle</b> signal to notice when your computer has been untouched for 10+ minutes or
          the screen is locked, so a break can be recorded. Only the start and end time of that period is used, and
          only when it&apos;s saved as a break. Nothing about what you were doing is recorded.
        </li>
        <li>It keeps your sign-in and a few preferences (your team, the client you&apos;re calling for) in Chrome&apos;s local storage.</li>
        <li>It talks only to Debrief&apos;s own database.</li>
      </ul>

      <h2>Who can see your data</h2>
      <ul>
        <li>You can see everything you logged (My stats).</li>
        <li>
          The managers of your team can see your logs, breaks, sign-offs and statistics. Other reps only ever see
          team averages, never your individual numbers.
        </li>
        <li>
          If your team connects Slack, short alerts (for example &quot;no pick-up for 35 minutes&quot;) with your name
          are posted to the Slack channel your managers chose.
        </li>
        <li>Debrief does not sell your data, use it for advertising, or share it with anyone else.</li>
      </ul>

      <h2>Service providers</h2>
      <p>
        Debrief&apos;s database and sign-in run on Supabase, and the dashboard is hosted on Vercel. They process data
        only to run Debrief. Data is sent over encrypted connections (HTTPS).
      </p>

      <h2>Keeping and deleting data</h2>
      <p>
        Data is kept while your team uses Debrief, so managers can compare results over time. You or your manager can
        ask for your account and data to be deleted at any time
        {CONTACT ? (
          <>
            {" "}by writing to <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
          </>
        ) : (
          " through your team's manager"
        )}
        . Logged calls can also be undone by you within 15 minutes of logging them.
      </p>

      <h2>Contact</h2>
      <p>
        {CONTACT ? (
          <>
            Questions about privacy: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
          </>
        ) : (
          <>Questions about privacy: use the support email on Debrief&apos;s Chrome Web Store page.</>
        )}
      </p>
    </main>
  );
}
