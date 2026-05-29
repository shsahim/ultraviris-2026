"use client";

import { useRouter } from "next/navigation";

export default function TableSelect({
  tables,
  selected,
}: {
  tables: string[];
  selected: string | null;
}) {
  const router = useRouter();

  return (
    <label className="admin-field">
      <span className="admin-label">Choose a table to manage</span>
      <select
        className="admin-input"
        value={selected ?? ""}
        onChange={(e) => {
          const value = e.target.value;
          if (value) {
            router.push(`/admin?table=${encodeURIComponent(value)}`);
          } else {
            router.push("/admin");
          }
        }}
      >
        <option value="">— Select a table —</option>
        {tables.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );
}
