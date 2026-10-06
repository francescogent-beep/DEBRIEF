"use client";

import { useRouter, useSearchParams } from "next/navigation";

// A dropdown that updates one query-string parameter and reloads the report.
export function FilterSelect({
  param,
  value,
  options,
  label,
}: {
  param: string;
  value: string;
  options: { value: string; label: string }[];
  label: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  return (
    <label className="filter-select">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => {
          const next = new URLSearchParams(params.toString());
          if (e.target.value) next.set(param, e.target.value);
          else next.delete(param);
          next.delete("page"); // a new filter starts from the first page
          router.push(`?${next.toString()}`);
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
