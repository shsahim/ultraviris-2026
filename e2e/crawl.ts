import { type Page } from "@playwright/test";

export interface CrawlResult {
  /** Visited internal path -> HTTP status. */
  pages: Map<string, number>;
  /** Human-readable problems found while crawling (bad status / empty render). */
  brokenPages: string[];
  /** Absolute http(s) URLs that point off-site. */
  externalLinks: Set<string>;
}

export interface CrawlOptions {
  maxPages?: number;
  /** Internal path prefixes to never visit (auth-gated areas, API routes). */
  excludePrefixes?: string[];
}

const SKIP_SCHEMES = ["mailto:", "tel:", "javascript:", "data:"];

/**
 * Breadth-first crawl of the site starting at "/". Visits every reachable
 * same-origin page, records its status and whether it rendered visible content,
 * and collects off-site links for separate verification.
 */
export async function crawl(
  page: Page,
  origin: string,
  opts: CrawlOptions = {}
): Promise<CrawlResult> {
  const maxPages = opts.maxPages ?? 60;
  const exclude = opts.excludePrefixes ?? ["/admin", "/api"];

  const queue: string[] = ["/"];
  const pages = new Map<string, number>();
  const brokenPages: string[] = [];
  const externalLinks = new Set<string>();

  const isExcluded = (p: string) => exclude.some((prefix) => p.startsWith(prefix));

  while (queue.length > 0 && pages.size < maxPages) {
    const path = queue.shift();
    if (!path || pages.has(path) || isExcluded(path)) continue;

    const response = await page.goto(path, { waitUntil: "domcontentloaded" });
    const status = response ? response.status() : 0;
    pages.set(path, status);

    if (!response || status >= 400) {
      brokenPages.push(`${path}: HTTP ${status}`);
      continue;
    }

    // "Renders correctly" signal: the body is visible and not blank. The shared
    // nav/footer guarantee text even when DB-backed galleries are empty in CI.
    const rendered = await page.evaluate(
      () => !!document.body && document.body.innerText.trim().length > 0
    );
    if (!rendered) {
      brokenPages.push(`${path}: rendered empty`);
      continue;
    }

    const hrefs = await page.$$eval("a[href]", (anchors) =>
      anchors.map((a) => a.getAttribute("href") ?? "")
    );

    for (const href of hrefs) {
      if (!href || href.startsWith("#")) continue;
      if (SKIP_SCHEMES.some((s) => href.toLowerCase().startsWith(s))) continue;

      let url: URL;
      try {
        url = new URL(href, origin);
      } catch {
        continue;
      }

      if (url.origin === origin) {
        const normalized = url.pathname + url.search;
        if (!isExcluded(normalized) && !pages.has(normalized)) {
          queue.push(normalized);
        }
      } else if (url.protocol === "http:" || url.protocol === "https:") {
        externalLinks.add(url.toString());
      }
    }
  }

  return { pages, brokenPages, externalLinks };
}
