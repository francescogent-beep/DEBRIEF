"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

// Quick presets plus a from → to date range. Writes ?range=… or ?from=…&to=… to the URL.
export function PeriodPicker({
  presets,
  current,
  fromDay,
  toDay,
  maxDay,
}: {
  presets: readonly { key: string; label: string }[];
  current: string; // preset key or "custom"
  fromDay: string;
  toDay: string;
  maxDay: string; // today
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [from, setFrom] = useState(fromDay);
  const [to, setTo] = useState(toDay);

  const go = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    next.delete("page");
    router.push(`?${next.toString()}`);
  };

  const changed = from !== fromDay || to !== toDay;

  return (
    <div className="period-picker">
      <label className="filter-select">
        <span>Period</span>
        <select
          value={current}
          onChange={(e) => {
            if (e.target.value === "custom") return;
            go({ range: e.target.value, from: null, to: null });
          }}
        >
          {presets.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom dates…</option>
        </select>
      </label>
      <form
        className="date-range"
        onSubmit={(e) => {
          e.preventDefault();
          if (!from) return;
          go({ range: null, from, to: to || maxDay });
        }}
      >
        <input
          type="date"
          aria-label="From"
          value={from}
          max={to || maxDay}
          onChange={(e) => setFrom(e.target.value)}
        />
        <span className="muted">→</span>
        <input type="date" aria-label="To" value={to} min={from} max={maxDay} onChange={(e) => setTo(e.target.value)} />
        <button className={`btn small ${changed ? "primary" : ""}`} type="submit" disabled={!changed}>
          Apply
        </button>
      </form>
    </div>
  );
}
