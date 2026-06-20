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
