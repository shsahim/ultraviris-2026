"use client";

import { useActionState, useEffect } from "react";
import {
  addEntryAction,
  updateEntryAction,
  type FormState,
} from "../actions";
import ImageUploadField from "./ImageUploadField";
import type { ColumnMeta } from "@/lib/admin-types";

const initialState: FormState = {};

const TEXTAREA_TYPES = new Set(["text", "mediumtext", "longtext", "tinytext"]);
const NUMBER_TYPES = new Set([
  "int",
  "bigint",
  "smallint",
  "tinyint",
  "mediumint",
  "decimal",
  "float",
  "double",
]);

function isNumeric(dataType: string): boolean {
  return NUMBER_TYPES.has(dataType.toLowerCase());
}

export default function EntryForm({
  mode,
  table,
  columns,
  activeColumn,
  primaryKey,
  row,
  imageBaseUrl = "",
  initialPreviewSrc,
  onDone,
}: {
  mode: "add" | "edit";
  table: string;
  columns: ColumnMeta[];
  activeColumn: string | null;
  primaryKey: string | null;
  row?: Record<string, unknown>;
  imageBaseUrl?: string;
  initialPreviewSrc?: string;
  onDone: () => void;
}) {
  const action = mode === "add" ? addEntryAction : updateEntryAction;
  const [state, formAction, pending] = useActionState(action, initialState);

  useEffect(() => {
    if (state.ok) {
      onDone();
    }
  }, [state.ok, onDone]);

  const idValue = primaryKey ? String(row?.[primaryKey] ?? "") : "";

  return (
    <form action={formAction} className="admin-entry-form">
      <input type="hidden" name="__table" value={table} />
      {mode === "edit" && <input type="hidden" name="__id" value={idValue} />}

      {columns.map((column) => {
        const isPk = column.name === primaryKey;
        // Auto-increment keys are managed by the database.
        if (column.isAutoIncrement && mode === "add") return null;

        const current = row?.[column.name];
        const stringValue =
          current === null || current === undefined ? "" : String(current);
        const readOnly = mode === "edit" && isPk;
        const fieldName = `field_${column.name}`;
        const labelText = `${column.name}${column.nullable ? "" : " *"}`;

        if (/file_location/i.test(column.name)) {
          return (
            <ImageUploadField
              key={column.name}
              table={table}
              fieldName={fieldName}
              label={labelText}
              initialValue={stringValue}
              imageBaseUrl={imageBaseUrl}
              initialPreviewSrc={
                /file_location/i.test(column.name) ? initialPreviewSrc : undefined
              }
            />
          );
        }

        if (column.name === activeColumn) {
          return (
            <label key={column.name} className="admin-field">
              <span className="admin-label">Status</span>
              <select
                name={fieldName}
                defaultValue={String(current ?? "1") === "0" ? "0" : "1"}
                className="admin-input"
              >
                <option value="1">Active</option>
                <option value="0">Inactive</option>
              </select>
            </label>
          );
        }

        return (
          <label key={column.name} className="admin-field">
            <span className="admin-label">{labelText}</span>
            {TEXTAREA_TYPES.has(column.dataType.toLowerCase()) ? (
              <textarea
                name={fieldName}
                defaultValue={stringValue}
                rows={3}
                readOnly={readOnly}
                className="admin-input admin-textarea"
              />
            ) : (
              <input
                type={isNumeric(column.dataType) ? "number" : "text"}
                step={isNumeric(column.dataType) ? "any" : undefined}
                name={fieldName}
                defaultValue={stringValue}
                readOnly={readOnly}
                className="admin-input"
              />
            )}
          </label>
        );
      })}

      <div className="admin-form-actions">
        <button type="submit" disabled={pending} className="admin-button">
          {pending ? "Saving..." : mode === "add" ? "Add entry" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="admin-button admin-button--ghost"
        >
          Cancel
        </button>
      </div>
      {state.error && (
        <p className="admin-note admin-note--error">{state.error}</p>
      )}
    </form>
  );
}
