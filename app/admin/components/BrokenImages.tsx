"use client";

import { useActionState } from "react";
import { deleteImageRowAction, type FormState } from "../actions";
import type { BrokenImage } from "@/lib/health";

const initial: FormState = {};

function DeleteRow({ table, id }: { table: string; id: string }) {
  const [state, action, pending] = useActionState(deleteImageRowAction, initial);
  return (
    <form action={action} className="admin-broken-delete">
      <input type="hidden" name="__table" value={table} />
      <input type="hidden" name="__id" value={id} />
      <button
        type="submit"
        className="admin-button admin-button--danger"
        disabled={pending}
      >
        {pending ? "Deleting…" : "Delete row"}
      </button>
      {state.error && (
        <span className="admin-note admin-note--error">{state.error}</span>
      )}
    </form>
  );
}

export default function BrokenImages({
  items,
  total,
}: {
  items: BrokenImage[];
  total: number;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <details className="admin-broken-images">
      <summary>Show broken images ({total})</summary>
      <p className="admin-muted admin-broken-help">
        These rows reference image files that are missing from storage. Deleting
        a row removes only the database entry.
      </p>
      <table className="admin-table admin-broken-table">
        <thead>
          <tr>
            <th>Table</th>
            <th>ID</th>
            <th>File_Location</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((b) => (
            <tr key={`${b.table}-${b.id}`}>
              <td>{b.table}</td>
              <td>{b.id}</td>
              <td>{b.path}</td>
              <td>
                <DeleteRow table={b.table} id={b.id} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {total > items.length && (
        <p className="admin-muted">
          Showing first {items.length} of {total}.
        </p>
      )}
    </details>
  );
}
