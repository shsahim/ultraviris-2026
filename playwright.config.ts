import { defineConfig, devices } from "@playwright/test";

// End-to-end suite for branch-CI: builds the app, serves it, and verifies every
// public page renders and links resolve across desktop + mobile browsers.
//
// No database is available in CI; the data loaders are resilient (return empty
// on failure), so pages still render their shell (nav/footer/layout). A dummy
// ADMIN_SESSION_SECRET is provided so the production server boots without real
// secrets.

const PORT = Number(process.env.E2E_PORT ?? 3000);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // One worker keeps the crawl deterministic and easy on the single dev server.
  workers: 1,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "Desktop Chrome", use: { ...devices["Desktop Chrome"] } },
    { name: "Desktop Firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "Desktop Safari", use: { ...devices["Desktop Safari"] } },
    { name: "Mobile Chrome", use: { ...devices["Pixel 5"] } },
    { name: "Mobile Safari", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    // next.config.ts uses output: "standalone", which `next start` can't serve.
    // e2e/serve.mjs assembles + launches the standalone server (honors E2E_PORT).
    command: "node e2e/serve.mjs",
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      ADMIN_SESSION_SECRET:
        process.env.ADMIN_SESSION_SECRET ??
        "local-e2e-dummy-session-secret-0123456789",
    },
  },
});
