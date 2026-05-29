import "server-only";
import os from "node:os";
import { query } from "@/lib/db";
import { getSiteHealth, type SiteHealth } from "@/lib/health";
import { sendAlertEmail } from "@/lib/email";

interface CheckResult {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

interface AlertRow {
  check_key: string;
  status: "ok" | "down";
  detail: string | null;
  last_notified_at: Date | null;
}

export interface MonitorResult {
  ok: boolean;
  dbDown: boolean;
  emailSent: boolean;
  newFailures: string[];
  recoveries: string[];
  checkedAt: string;
}

const RESEND_MS = (Number(process.env.ALERT_RESEND_MINUTES) || 60) * 60_000;
const INSTANCE = process.env.HOSTNAME || os.hostname();
const APP_NAME = "ultraviris";

// Translates the rich SiteHealth object into a flat list of pass/fail checks.
// `not_configured` email is treated as a configuration choice, not an outage.
function deriveChecks(health: SiteHealth): CheckResult[] {
  const checks: CheckResult[] = [
    {
      key: "email",
      label: "Email (SES)",
      ok: health.email.status !== "error",
      detail: health.email.message,
    },
    {
      key: "storage",
      label: "Image storage",
      ok: health.storage.ok,
      detail: health.storage.message,
    },
  ];

  if (!health.images.skipped) {
    checks.push({
      key: "images",
      label: "Images",
      ok: health.images.broken === 0,
      detail: health.images.message,
    });
  }

  return checks;
}

async function ensureAlertTable(): Promise<void> {
  await query(
    `CREATE TABLE IF NOT EXISTS health_alerts (
       check_key VARCHAR(64) NOT NULL PRIMARY KEY,
       status VARCHAR(16) NOT NULL,
       detail TEXT NULL,
       last_notified_at DATETIME NULL,
       updated_at DATETIME NOT NULL
     )`
  );
}

async function loadAlertState(): Promise<Map<string, AlertRow>> {
  const rows = await query<AlertRow>(
    "SELECT check_key, status, detail, last_notified_at FROM health_alerts"
  );
  return new Map(rows.map((r) => [r.check_key, r]));
}

async function upsertAlert(
  key: string,
  status: "ok" | "down",
  detail: string,
  lastNotifiedAt: Date | null
): Promise<void> {
  await query(
    `INSERT INTO health_alerts (check_key, status, detail, last_notified_at, updated_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       detail = VALUES(detail),
       last_notified_at = VALUES(last_notified_at),
       updated_at = VALUES(updated_at)`,
    [key, status, detail, lastNotifiedAt]
  );
}

function composeBody(
  newFailures: CheckResult[],
  recoveries: CheckResult[],
  checkedAt: string
): string {
  const lines: string[] = [];
  if (newFailures.length > 0) {
    lines.push("FAILING CHECKS:");
    for (const c of newFailures) {
      lines.push(`  ✗ ${c.label}: ${c.detail}`);
    }
    lines.push("");
  }
  if (recoveries.length > 0) {
    lines.push("RECOVERED:");
    for (const c of recoveries) {
      lines.push(`  ✓ ${c.label}: ${c.detail}`);
    }
    lines.push("");
  }
  lines.push(`Checked at: ${checkedAt}`);
  lines.push(`Reporting instance: ${INSTANCE}`);
  return lines.join("\n");
}

/**
 * Runs all health checks and emails alerts for any newly-failing or
 * newly-recovered subsystems. Designed to be invoked by a single external
 * scheduler (see /api/health/cron) so an autoscaled fleet doesn't duplicate
 * notifications; dedup/throttle state lives in the shared `health_alerts` table.
 */
export async function runHealthCheckAndAlert(): Promise<MonitorResult> {
  const health = await getSiteHealth();
  const checkedAt = health.checkedAt;

  // If the database is down we can't use it for cross-instance dedup, and most
  // other checks are meaningless. Alert directly (throttled by cron cadence).
  if (!health.ok) {
    let emailSent = false;
    try {
      await sendAlertEmail({
        subject: `[${APP_NAME}] ALERT: database unreachable`,
        body: composeBody(
          [
            {
              key: "database",
              label: "Database",
              ok: false,
              detail: health.error ?? "Not connected",
            },
          ],
          [],
          checkedAt
        ),
      });
      emailSent = true;
    } catch {
      // Swallow — nothing more we can do if SES is also unavailable.
    }
    return {
      ok: false,
      dbDown: true,
      emailSent,
      newFailures: ["database"],
      recoveries: [],
      checkedAt,
    };
  }

  await ensureAlertTable();
  const state = await loadAlertState();

  // Database is up — record it as healthy (recovery handled implicitly).
  const checks = [
    { key: "database", label: "Database", ok: true, detail: "Connected" },
    ...deriveChecks(health),
  ];

  const now = new Date();
  const newFailures: CheckResult[] = [];
  const recoveries: CheckResult[] = [];

  for (const check of checks) {
    const row = state.get(check.key);

    if (!check.ok) {
      const wasDown = row?.status === "down";
      const lastNotified = row?.last_notified_at
        ? new Date(row.last_notified_at).getTime()
        : 0;
      const resendDue = now.getTime() - lastNotified >= RESEND_MS;

      if (!wasDown || resendDue) {
        newFailures.push(check);
        await upsertAlert(check.key, "down", check.detail, now);
      } else {
        await upsertAlert(check.key, "down", check.detail, row.last_notified_at);
      }
    } else {
      if (row?.status === "down") {
        recoveries.push(check);
      }
      await upsertAlert(check.key, "ok", check.detail, null);
    }
  }

  let emailSent = false;
  if (newFailures.length > 0 || recoveries.length > 0) {
    const failCount = newFailures.length;
    const subject =
      failCount > 0
        ? `[${APP_NAME}] ALERT: ${failCount} check${failCount > 1 ? "s" : ""} failing`
        : `[${APP_NAME}] Recovered: all checks healthy`;
    try {
      await sendAlertEmail({
        subject,
        body: composeBody(newFailures, recoveries, checkedAt),
      });
      emailSent = true;
    } catch {
      // Leave emailSent false; the next tick will retry the still-failing checks.
    }
  }

  return {
    ok: newFailures.length === 0,
    dbDown: false,
    emailSent,
    newFailures: newFailures.map((c) => c.key),
    recoveries: recoveries.map((c) => c.key),
    checkedAt,
  };
}
