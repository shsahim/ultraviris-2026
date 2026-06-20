import { expect, test } from "@playwright/test";

import { crawl } from "./crawl";

// Runs across every configured project (Desktop Chrome/Firefox/Safari + Mobile
// Chrome/Safari), so a pass means all public pages render in every browser and
// viewport, and no internal link 404s.
test("all public pages render and internal links resolve", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const { pages, brokenPages } = await crawl(page, origin);

  expect(pages.size, "should reach at least the homepage").toBeGreaterThan(0);
  expect(
    brokenPages,
    `Pages that failed to load/render:\n  ${brokenPages.join("\n  ")}`
  ).toEqual([]);

  // Surface the crawl coverage in the report for visibility.
  test.info().annotations.push({
    type: "crawled",
    description: `${pages.size} page(s): ${[...pages.keys()].join(", ")}`,
  });
});

// External links are verified once (Chromium) to avoid hammering third parties
// from every project. A link is "broken" only if it definitively returns
// 404/410; transient/network/anti-bot responses are reported as warnings so the
// merge gate stays stable against third-party flakiness.
test("external links are not dead", async ({ page, baseURL, browserName, request }) => {
  test.skip(browserName !== "chromium", "external link check runs once");

  const origin = new URL(baseURL!).origin;
  const { externalLinks } = await crawl(page, origin);

  const DEAD = new Set([404, 410]);
  const dead: string[] = [];

  for (const url of externalLinks) {
    let status = 0;
    try {
      let res = await request.head(url, { timeout: 15_000, maxRedirects: 5 });
      status = res.status();
      // Some hosts reject HEAD (403/405) — retry with GET before judging.
      if (status === 403 || status === 405 || status === 501) {
        res = await request.get(url, { timeout: 15_000, maxRedirects: 5 });
        status = res.status();
      }
    } catch {
      test.info().annotations.push({
        type: "warning",
        description: `Unreachable (network/timeout): ${url}`,
      });
      continue;
    }

    if (DEAD.has(status)) {
      dead.push(`${url} -> ${status}`);
    } else if (status >= 400) {
      test.info().annotations.push({
        type: "warning",
        description: `${url} -> ${status}`,
      });
    }
  }

  expect(dead, `Dead external links:\n  ${dead.join("\n  ")}`).toEqual([]);
});
