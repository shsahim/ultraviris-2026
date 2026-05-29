"use client";

import { useState } from "react";
import Link from "next/link";
import { setActiveAction } from "../actions";
import EntryForm from "./EntryForm";
import { resolveImageSrc } from "@/lib/images";
import type { ColumnMeta, Row } from "@/lib/admin-db";

function isFileLocationColumn(name: string): boolean {
  return /file_location/i.test(name);
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  const str = String(value);
  return str.length > 60 ? `${str.slice(0, 60)}…` : str;
}

export default function TableManager({
  table,
  columns,
  rows,
  primaryKey,
  activeColumn,
  total,
  page,
  pageSize,
  showTitle = true,
  embedded = false,
}: {
  table: string;
  columns: ColumnMeta[];
  rows: Row[];
  primaryKey: string | null;
  activeColumn: string | null;
  total: number;
  page: number;
  pageSize: number;
  showTitle?: boolean;
  embedded?: boolean;
}) {
  const [editing, setEditing] = useState<Row | null>(null);
  const [adding, setAdding] = useState(false);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const canEdit = Boolean(primaryKey);

  return (
    <div className={embedded ? "" : "admin-section"}>
      <div className="admin-section-header">
        {showTitle ? (
          <h2 className="admin-subtitle">
            {table}{" "}
            <span className="admin-muted">({total} rows)</span>
          </h2>
        ) : (
          <span />
        )}
        <button
          className="admin-button"
          onClick={() => {
            setEditing(null);
            setAdding(true);
          }}
        >
          + Add new entry
        </button>
      </div>

      {!canEdit && (
        <p className="admin-note admin-note--error">
          This table has no primary key, so individual rows can&apos;t be edited
          or toggled.
        </p>
      )}

      {adding && (
        <div className="admin-panel">
          <h3 className="admin-subtitle">Add to {table}</h3>
          <EntryForm
            mode="add"
            table={table}
            columns={columns}
            activeColumn={activeColumn}
            primaryKey={primaryKey}
            onDone={() => setAdding(false)}
          />
        </div>
      )}

      {editing && primaryKey && (
        <div className="admin-panel">
          <h3 className="admin-subtitle">
            Edit {table} #{String(editing[primaryKey])}
          </h3>
          <EntryForm
            mode="edit"
            table={table}
            columns={columns}
            activeColumn={activeColumn}
            primaryKey={primaryKey}
            row={editing}
            onDone={() => setEditing(null)}
          />
        </div>
      )}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              {canEdit && <th>Actions</th>}
              {columns.map((c) => (
                <th key={c.name}>{c.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length + (canEdit ? 1 : 0)}>
                  No rows yet.
                </td>
              </tr>
            )}
            {rows.map((row, i) => {
              const id = primaryKey ? String(row[primaryKey]) : String(i);
              const isActive =
                activeColumn != null &&
                String(row[activeColumn]) !== "0" &&
                row[activeColumn] != null;
              return (
                <tr key={id}>
                  {canEdit && (
                    <td className="admin-actions-cell">
                      <button
                        className="admin-button admin-button--small"
                        onClick={() => {
                          setAdding(false);
                          setEditing(row);
                        }}
                      >
                        Edit
                      </button>
                      {activeColumn && (
                        <form action={setActiveAction}>
                          <input type="hidden" name="__table" value={table} />
                          <input type="hidden" name="__id" value={id} />
                          <input
                            type="hidden"
                            name="__active"
                            value={isActive ? "0" : "1"}
                          />
                          <button
                            type="submit"
                            className={`admin-toggle ${
                              isActive ? "admin-toggle--on" : "admin-toggle--off"
                            }`}
                            title="Click to change status"
                          >
                            {isActive ? "Active" : "Inactive"}
                          </button>
                        </form>
                      )}
                    </td>
                  )}
                  {columns.map((c) => {
                    const value = row[c.name];
                    if (isFileLocationColumn(c.name) && value) {
                      return (
                        <td key={c.name}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={resolveImageSrc(String(value))}
                            alt={String(value)}
                            className="admin-thumb"
                          />
                        </td>
                      );
                    }
                    return <td key={c.name}>{formatCell(value)}</td>;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="admin-pagination">
          {page > 1 ? (
            <Link
              className="admin-button admin-button--ghost"
              href={`/admin?table=${encodeURIComponent(table)}&page=${page - 1}`}
            >
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="admin-muted">
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? (
            <Link
              className="admin-button admin-button--ghost"
              href={`/admin?table=${encodeURIComponent(table)}&page=${page + 1}`}
            >
              Next →
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </div>
  );
}
