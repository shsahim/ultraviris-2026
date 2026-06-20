"use client";

import { useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fetchIssueCommentsAction } from "../actions";
import type { IssueComment, IssueSummary } from "@/lib/github";

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.floor((Date.now() - then) / 1000);
  const units: [number, string][] = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [secs, label] of units) {
    const value = Math.floor(seconds / secs);
    if (value >= 1) return `${value} ${label}${value === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

// Picks readable text color (black/white) for a given GitHub label hex color.
function contrastText(hex: string): string {
  const clean = hex.replace(/^#/, "");
  if (clean.length !== 6) return "#000000";
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#000000" : "#ffffff";
}

function IssueRow({ issue }: { issue: IssueSummary }) {
  const [expanded, setExpanded] = useState(false);
  const [comments, setComments] = useState<IssueComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, startTransition] = useTransition();

  function toggleComments() {
    const next = !expanded;
    setExpanded(next);
    if (next && !loaded) {
      setError(null);
      startTransition(async () => {
        const result = await fetchIssueCommentsAction(issue.number);
        if (result.error) {
          setError(result.error);
        } else {
          setComments(result.comments ?? []);
          setLoaded(true);
        }
      });
    }
  }

  return (
    <li className="admin-issue">
      <div className="admin-issue-head">
        <div className="admin-issue-main">
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="admin-issue-title"
          >
            <span className="admin-issue-number">#{issue.number}</span>
            {issue.title}
          </a>
          <div className="admin-issue-meta admin-muted">
            <span>by {issue.author}</span>
            <span>·</span>
            <span>updated {timeAgo(issue.updatedAt)}</span>
          </div>
          {issue.labels.length > 0 && (
            <div className="admin-issue-labels">
              {issue.labels.map((label) => (
                <span
                  key={label.name}
                  className="admin-issue-label"
                  style={{
                    backgroundColor: `#${label.color}`,
                    color: contrastText(label.color),
                  }}
                >
                  {label.name}
                </span>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          className="admin-button admin-button--small admin-button--ghost"
          onClick={toggleComments}
          aria-expanded={expanded}
        >
          {expanded ? "Hide" : "Comments"} ({issue.comments})
        </button>
      </div>

      {expanded && (
        <div className="admin-issue-comments">
          {pending && <p className="admin-muted">Loading comments…</p>}
          {error && (
            <p className="admin-note admin-note--error">{error}</p>
          )}
          {!pending && !error && comments && comments.length === 0 && (
            <p className="admin-muted">No comments yet.</p>
          )}
          {!pending &&
            !error &&
            comments &&
            comments.map((comment) => (
              <div key={comment.id} className="admin-comment">
                <div className="admin-comment-head admin-muted">
                  <strong>{comment.author}</strong>
                  <span>· {timeAgo(comment.createdAt)}</span>
                </div>
                <div className="admin-comment-body markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {comment.body}
                  </ReactMarkdown>
                </div>
              </div>
            ))}
        </div>
      )}
    </li>
  );
}

export default function ActiveIssues({
  configured,
  repo,
  issues,
  error,
}: {
  configured: boolean;
  repo: string;
  issues: IssueSummary[];
  error?: string;
}) {
  return (
    <section className="admin-section" id="issues">
      <h2 className="admin-subtitle">
        Active Issues{" "}
        <span className="admin-muted">({issues.length})</span>
      </h2>

      {!configured ? (
        <p className="admin-note admin-note--error">
          GitHub access isn&apos;t configured. Set <code>GITHUB_TOKEN</code> (a
          fine-grained PAT with Issues: Read) to enable this widget.
        </p>
      ) : error ? (
        <p className="admin-note admin-note--error">{error}</p>
      ) : issues.length === 0 ? (
        <p className="admin-muted">No open issues. Nice work.</p>
      ) : (
        <ul className="admin-issue-list">
          {issues.map((issue) => (
            <IssueRow key={issue.number} issue={issue} />
          ))}
        </ul>
      )}

      <p className="admin-muted admin-issue-repo-note">
        <a href={`https://github.com/${repo}/issues`} target="_blank" rel="noopener noreferrer">
          View all on GitHub →
        </a>
      </p>
    </section>
  );
}
