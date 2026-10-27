"use client";

import { useActionState, useState } from "react";
import { saveAlertSettings, testSlack, type ActionState } from "@/app/actions";

type Settings = {
  enabled: boolean;
  quiet_minutes: number;
  start_hour: number;
  end_hour: number;
  slack_enabled: boolean;
  slack_webhook: string | null;
};

const hourLabel = (h: number) => (h === 0 || h === 24 ? "12am" : h === 12 ? "12pm" : h < 12 ? `${h}am` : `${h - 12}pm`);

export function AlertSettingsForm({ workspaceId, s, appUrl }: { workspaceId: string; s: Settings; appUrl: string }) {
  const [saved, save, saving] = useActionState<ActionState, FormData>(saveAlertSettings, undefined);
  const [tested, test, testing] = useActionState<ActionState, FormData>(testSlack, undefined);
  const msg = tested ?? saved;
  // Controlled so the form reset after saving doesn't jump them back to 12am.
  const [start, setStart] = useState(String(s.start_hour));
  const [end, setEnd] = useState(String(s.end_hour));
  const [minutes, setMinutes] = useState(String(s.quiet_minutes));
  const [webhook, setWebhook] = useState(s.slack_webhook ?? "");
  const [enabled, setEnabled] = useState(s.enabled);
  const [slackOn, setSlackOn] = useState(s.slack_enabled);
  return (
    <form action={save} className="stack alert-form">
      <input type="hidden" name="workspace_id" value={workspaceId} />
      <input type="hidden" name="app_url" value={appUrl} />
      <label className="check-row">
        <input type="checkbox" name="enabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Alert managers when a rep goes quiet
      </label>
      <div className="alert-grid">
        <label>
          No pick-up for (minutes)
          <input name="quiet_minutes" type="number" min={10} max={240} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </label>
        <label>
          From
          <select name="start_hour" value={start} onChange={(e) => setStart(e.target.value)}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Until
          <select name="end_hour" value={end} onChange={(e) => setEnd(e.target.value)}>
            {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Slack webhook URL
        <input
          name="slack_webhook"
          type="url"
          placeholder="https://hooks.slack.com/services/…"
          value={webhook}
          onChange={(e) => setWebhook(e.target.value)}
          autoComplete="off"
        />
      </label>
      <label className="check-row">
        <input type="checkbox" name="slack_enabled" checked={slackOn} onChange={(e) => setSlackOn(e.target.checked)} /> Send alerts to Slack
      </label>
      {msg?.error && <p className="msg">{msg.error}</p>}
      {msg?.ok && <p className="msg ok">{msg.ok}</p>}
      <div className="row">
        <button className="btn primary" disabled={saving}>
          {saving ? "Saving…" : "Save alerts"}
        </button>
        <button className="btn" formAction={test} disabled={testing}>
          {testing ? "Sending…" : "Send a test to Slack"}
        </button>
      </div>
    </form>
  );
}
