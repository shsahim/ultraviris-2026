import "server-only";

// Minimal GitHub REST client for opening issues from the admin area. Auth uses a
// fine-grained PAT (Issues: Read & Write on the target repo) supplied via the
// GITHUB_TOKEN env var — never hardcoded and never exposed to the client.

const GITHUB_API = "https://api.github.com";
const DEFAULT_REPO = "shsahim/ultraviris-2026";

// GitHub's hard limit on issue bodies is 65536 chars; stay comfortably under it.
const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 60_000;

/** owner/repo that issues are opened against (override with GITHUB_ISSUE_REPO). */
export function getIssueRepo(): string {
  return process.env.GITHUB_ISSUE_REPO?.trim() || DEFAULT_REPO;
}

/** True when a token is configured so the feature can be enabled in the UI. */
export function isGitHubIssuesConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN);
}

export interface CreateIssueInput {
  title: string;
  body: string;
  labels?: string[];
}

export interface CreatedIssue {
  number: number;
  url: string;
}

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ultraviris-admin",
  };
}

function describeError(status: number, detail: string, repo: string): string {
  if (status === 401) {
    return "GitHub rejected the token (401). Check that GITHUB_TOKEN is valid.";
  }
  if (status === 403) {
    return "GitHub denied the request (403). The token likely lacks Issues: Write on this repo.";
  }
  if (status === 404) {
    return `Repository "${repo}" was not found, or the token can't see it (404).`;
  }
  if (status === 410) {
    return "Issues are disabled for this repository (410).";
  }
  return detail ? `GitHub error: ${detail}` : `GitHub returned HTTP ${status}.`;
}

/** Creates (and populates) a GitHub issue. Throws a friendly error on failure. */
export async function createIssue({
  title,
  body,
  labels,
}: CreateIssueInput): Promise<CreatedIssue> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GitHub issue creation is not configured (GITHUB_TOKEN is not set)."
    );
  }

  const repo = getIssueRepo();
  const cleanTitle = title.trim();
  if (!cleanTitle) {
    throw new Error("An issue title is required.");
  }
  if (cleanTitle.length > MAX_TITLE_LENGTH) {
    throw new Error(`Title is too long (max ${MAX_TITLE_LENGTH} characters).`);
  }
  if (body.length > MAX_BODY_LENGTH) {
    throw new Error(`Body is too long (max ${MAX_BODY_LENGTH} characters).`);
  }

  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        ...authHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: cleanTitle,
        body,
        ...(labels && labels.length > 0 ? { labels } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Could not reach GitHub. Please try again.");
  }

  if (!res.ok) {
    let detail = "";
    try {
      const data = (await res.json()) as { message?: string };
      detail = data?.message ?? "";
    } catch {
      // non-JSON error body; fall back to status-based message
    }
    throw new Error(describeError(res.status, detail, repo));
  }

  const data = (await res.json()) as { number: number; html_url: string };
  return { number: data.number, url: data.html_url };
}

export interface IssueLabel {
  name: string;
  color: string;
}

export interface IssueSummary {
  number: number;
  title: string;
  url: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  comments: number;
  labels: IssueLabel[];
}

export interface IssueComment {
  id: number;
  author: string;
  body: string;
  url: string;
  createdAt: string;
}

interface RawIssue {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  comments: number;
  labels: Array<{ name: string; color: string } | string>;
  pull_request?: unknown;
}

interface RawComment {
  id: number;
  body: string | null;
  html_url: string;
  user: { login: string } | null;
  created_at: string;
}

/**
 * Lists open issues for the configured repo. Pull requests (which the GitHub
 * issues endpoint also returns) are filtered out. Throws a friendly error on
 * failure.
 */
export async function listOpenIssues(limit = 30): Promise<IssueSummary[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GitHub access is not configured (GITHUB_TOKEN is not set)."
    );
  }

  const repo = getIssueRepo();
  const perPage = Math.min(Math.max(limit, 1), 100);

  let res: Response;
  try {
    res = await fetch(
      `${GITHUB_API}/repos/${repo}/issues?state=open&per_page=${perPage}&sort=updated&direction=desc`,
      {
        headers: authHeaders(token),
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      }
    );
  } catch {
    throw new Error("Could not reach GitHub. Please try again.");
  }

  if (!res.ok) {
    throw new Error(describeError(res.status, "", repo));
  }

  const data = (await res.json()) as RawIssue[];
  return data
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      body: issue.body ?? "",
      author: issue.user?.login ?? "unknown",
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      comments: issue.comments,
      labels: issue.labels.map((label) =>
        typeof label === "string"
          ? { name: label, color: "888888" }
          : { name: label.name, color: label.color }
      ),
    }));
}

/** Fetches the comments for a single issue. Throws a friendly error on failure. */
export async function getIssueComments(
  issueNumber: number
): Promise<IssueComment[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GitHub access is not configured (GITHUB_TOKEN is not set)."
    );
  }

  const repo = getIssueRepo();

  let res: Response;
  try {
    res = await fetch(
      `${GITHUB_API}/repos/${repo}/issues/${issueNumber}/comments?per_page=100`,
      {
        headers: authHeaders(token),
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      }
    );
  } catch {
    throw new Error("Could not reach GitHub. Please try again.");
  }

  if (!res.ok) {
    throw new Error(describeError(res.status, "", repo));
  }

  const data = (await res.json()) as RawComment[];
  return data.map((comment) => ({
    id: comment.id,
    author: comment.user?.login ?? "unknown",
    body: comment.body ?? "",
    url: comment.html_url,
    createdAt: comment.created_at,
  }));
}

/**
 * Lightweight token/repo health probe for the admin Site Health panel. Confirms
 * the token can see the repo and whether issues are enabled, without creating
 * anything.
 */
export async function checkGitHubAccess(): Promise<{
  ok: boolean;
  message: string;
}> {
  const token = process.env.GITHUB_TOKEN;
  const repo = getIssueRepo();
  if (!token) {
    return {
      ok: false,
      message: "GITHUB_TOKEN not set — the issue reporter is disabled.",
    };
  }
  try {
    const res = await fetch(`${GITHUB_API}/repos/${repo}`, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return { ok: false, message: describeError(res.status, "", repo) };
    }
    const data = (await res.json()) as { has_issues?: boolean };
    if (data.has_issues === false) {
      return { ok: false, message: `Issues are disabled on ${repo}.` };
    }
    return { ok: true, message: `Connected to ${repo}.` };
  } catch {
    return { ok: false, message: "Could not reach GitHub." };
  }
}
