// Export definitions shared by the CSV route and the settings page.

export type ExportKind = "daily" | "clients" | "calls";

export const EXPORTS: {
  kind: ExportKind;
  file: string;
  title: string;
  description: string;
  columns: [key: string, header: string][];
}[] = [
  {
    kind: "daily",
    file: "daily-report.csv",
    title: "Daily report",
    description: "One row per rep per day: dials, pick-ups, booked, target, and their end-of-day notes.",
    columns: [
      ["date", "Date"],
      ["rep", "Rep"],
      ["email", "Email"],
      ["dials", "Dials"],
      ["conversations", "Pick-ups"],
      ["booked", "Booked"],
      ["book_rate", "Book rate %"],
      ["on_target", "On target"],
      ["energy", "Energy (1-5)"],
      ["went_well", "How the day went"],
      ["improve", "To improve"],
      ["blockers", "Blockers"],
      ["dials_by_client", "Dials by client"],
    ],
  },
  {
    kind: "clients",
    file: "rep-by-client.csv",
    title: "Rep × client by day",
    description: "One row per rep, per client, per day: dials, pick-ups, booked, where calls died, top objection.",
    columns: [
      ["date", "Date"],
      ["rep", "Rep"],
      ["client", "Client"],
      ["dials", "Dials"],
      ["conversations", "Pick-ups"],
      ["booked", "Booked"],
      ["most_died_at", "Most died at"],
      ["top_objection", "Top objection"],
    ],
  },
  {
    kind: "calls",
    file: "call-log.csv",
    title: "Call log",
    description: "Every answered call: time, rep, client, outcome, where it died, objection and note.",
    columns: [
      ["date", "Date"],
      ["time", "Time"],
      ["rep", "Rep"],
      ["client", "Client"],
      ["outcome", "Outcome"],
      ["booked", "Booked"],
      ["died_at", "Where it died"],
      ["objection", "Objection"],
      ["note", "Note"],
    ],
  },
];

// Quote a CSV cell. Cells that start with = + - @ are prefixed with ' so a
// rep's note can never run as a formula in Sheets or Excel.
function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "number" ? String(v) : String(v);
  if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[], columns: [string, string][]): string {
  const lines = [columns.map(([, h]) => cell(h)).join(",")];
  for (const r of rows) lines.push(columns.map(([k]) => cell(r[k])).join(","));
  return lines.join("\r\n") + "\r\n";
}
