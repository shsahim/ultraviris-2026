"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createIssueAction, type IssueFormState } from "../actions";

const initial: IssueFormState = {};

type Tab = "write" | "preview";

const ISSUE_TYPES = [
  { value: "bug", label: "Issue / Bug" },
  { value: "feature", label: "Feature request" },
];

export default function IssueReporter({
  configured,
  repo,
}: {
  configured: boolean;
  repo: string;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("write");
  const [title, setTitle] = useState("");
  const [issueType, setIssueType] = useState(ISSUE_TYPES[0].value);
  const [body, setBody] = useState("");
  const [state, action, pending] = useActionState(createIssueAction, initial);
  const panelRef = useRef<HTMLDivElement>(null);

  // Clear the composer once an issue is successfully filed.
  useEffect(() => {
    if (state.ok) {
      setTitle("");
      setBody("");
      setIssueType(ISSUE_TYPES[0].value);
      setTab("write");
    }
  }, [state.ok]);

  // Close on Escape for keyboard users.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="issue-reporter">
      {open && (
        <div
          className="issue-panel"
          role="dialog"
          aria-label="Report an issue"
          ref={panelRef}
        >
          <div className="issue-panel-head">
            <div>
              <strong>Report an issue</strong>
              <span className="admin-muted issue-repo">{repo}</span>
            </div>
            <button
              type="button"
              className="issue-close"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </div>

          {!configured ? (
            <p className="admin-note admin-note--error issue-disabled">
              Issue reporting isn&apos;t configured. Set <code>GITHUB_TOKEN</code>{" "}
              (a fine-grained PAT with Issues: Read &amp; Write) to enable it.
            </p>
          ) : state.ok ? (
            <div className="issue-success">
              <p>
                Issue <strong>#{state.issueNumber}</strong> created.
              </p>
              <a
                href={state.issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="admin-button admin-button--ghost"
              >
                View on GitHub
              </a>
              <button
                type="button"
                className="admin-button admin-button--small"
                onClick={() => {
                  // Reset success state by reopening a fresh composer.
                  setTab("write");
                  setOpen(false);
                  setTimeout(() => setOpen(true), 0);
                }}
              >
                File another
              </button>
            </div>
          ) : (
            <form action={action} className="issue-form">
              <div className="issue-meta-row">
                <input
                  type="text"
                  name="title"
                  className="admin-input issue-title-input"
                  placeholder="Issue title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={256}
                  required
                />
                <select
                  name="issueType"
                  className="admin-input issue-type-select"
                  value={issueType}
                  onChange={(e) => setIssueType(e.target.value)}
                  aria-label="Issue type"
                >
                  {ISSUE_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="issue-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "write"}
                  className={`issue-tab ${tab === "write" ? "issue-tab--active" : ""}`}
                  onClick={() => setTab("write")}
                >
                  Write
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "preview"}
                  className={`issue-tab ${tab === "preview" ? "issue-tab--active" : ""}`}
                  onClick={() => setTab("preview")}
                >
                  Preview
                </button>
                <span className="admin-muted issue-hint">Markdown supported</span>
              </div>

              {/* Keep the textarea mounted (just hidden) so its value persists
                  and is always submitted with the form. */}
              <textarea
                name="body"
                className="admin-input admin-textarea issue-textarea"
                placeholder="Describe the issue. Markdown works: **bold**, `code`, - lists, etc."
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
                required
                hidden={tab !== "write"}
              />

              {tab === "preview" && (
                <div className="issue-preview markdown-body">
                  {body.trim() ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {body}
                    </ReactMarkdown>
                  ) : (
                    <p className="admin-muted">Nothing to preview yet.</p>
                  )}
                </div>
              )}

              {state.error && (
                <p className="admin-note admin-note--error">{state.error}</p>
              )}

              <div className="issue-actions">
                <button
                  type="submit"
                  className="admin-button"
                  disabled={pending}
                >
                  {pending ? "Opening…" : "Open issue"}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      <button
        type="button"
        className="issue-fab"
        aria-expanded={open}
        aria-label={open ? "Close issue reporter" : "Report an issue"}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Close" : "Report an issue"}
      </button>
    </div>
  );
}
