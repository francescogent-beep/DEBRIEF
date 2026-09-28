// Small, dependency-free charts. One hue for single-series magnitude;
// every bar has a native hover tooltip and a direct value label.

type BarItem = { id: string; label: string; n: number };

export function BarList({
  items,
  total,
  empty,
  unit = "calls",
}: {
  items: BarItem[];
  total: number;
  empty: string;
  unit?: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.n));
  if (!items.some((i) => i.n > 0)) return <p className="muted small empty">{empty}</p>;
  return (
    <ul className="barlist">
      {items.map((i) => {
        const share = total ? Math.round((i.n / total) * 100) : 0;
        return (
          <li key={i.id} title={`${i.label}: ${i.n} ${unit} (${share}%)`}>
            <span className="bl-label">{i.label}</span>
            <span className="bl-track">
              <span className="bl-fill" style={{ width: `${(i.n / max) * 100}%` }} />
            </span>
            <span className="bl-value">
              {i.n} <em>{share}%</em>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function DailyChart({
  days,
}: {
  days: { day: string; conversations: number; booked: number }[];
}) {
  const max = Math.max(1, ...days.map((d) => d.conversations));
  const fmt = (d: string) =>
    new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const labelEvery = days.length > 14 ? 5 : days.length > 7 ? 2 : 1;
  return (
    <figure className="daily">
      <div className="legend">
        <span><i className="sw conv" /> Conversations</span>
        <span><i className="sw booked" /> Booked</span>
      </div>
      <div className="daily-plot" role="img" aria-label="Conversations and booked appointments per day">
        {days.map((d, idx) => (
          <div className="daily-col" key={d.day} title={`${fmt(d.day)} — ${d.conversations} conversations, ${d.booked} booked`}>
            <div className="daily-bars">
              <span className="bar conv" style={{ height: `${(d.conversations / max) * 100}%` }} />
              <span className="bar booked" style={{ height: `${(d.booked / max) * 100}%` }} />
            </div>
            <span className="daily-x">{idx % labelEvery === 0 ? fmt(d.day) : ""}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}
