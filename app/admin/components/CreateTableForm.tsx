"use client";

import { useActionState } from "react";
import { createTableAction, type FormState } from "../actions";

const initialState: FormState = {};

export default function CreateTableForm() {
  const [state, action, pending] = useActionState(
    createTableAction,
    initialState
  );

  return (
    <form action={action} className="admin-create-table">
      <label className="admin-field">
        <span className="admin-label">
          New table name (copies the brain_juice structure)
        </span>
        <input
          name="table_name"
          className="admin-input"
          placeholder="e.g. featured_works"
          required
        />
      </label>
      <button type="submit" className="admin-button" disabled={pending}>
        {pending ? "Creating..." : "Create table"}
      </button>
      {state.error && (
        <p className="admin-note admin-note--error">{state.error}</p>
      )}
    </form>
  );
}
