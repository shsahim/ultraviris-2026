"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import {
  destroySession,
  getSessionUsername,
  isAuthed,
  login,
} from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import {
  changePassword,
  createUser,
  deleteUser,
} from "@/lib/admin-users";
import {
  createTableLike,
  deleteRow,
  ensureProjectEntry,
  getActiveColumn,
  getColumns,
  getPrimaryKey,
  insertRow,
  setActive,
  slugifyTableName,
  updateRow,
} from "@/lib/admin-db";
import type { ColumnMeta } from "@/lib/admin-types";
import { invalidateAll } from "@/lib/cache";
import { createIssue } from "@/lib/github";

const PROJECTS_TABLE = "active_projects";

// Throttle sign-in attempts per IP to slow online password guessing.
const LOGIN_RATE_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 }; // 10 / 15 min

export interface FormState {
  ok?: boolean;
  error?: string;
}

export interface IssueFormState {
  ok?: boolean;
  error?: string;
  issueUrl?: string;
  issueNumber?: number;
}

export async function loginAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const ip = clientIp(await headers());
  if (!rateLimit(`login:${ip}`, LOGIN_RATE_LIMIT).ok) {
    return { error: "Too many sign-in attempts. Please try again later." };
  }

  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!username || !password) {
    return { error: "Enter a username and password." };
  }
  let ok: boolean;
  try {
    ok = await login(username, password);
  } catch {
    return { error: "Sign-in is temporarily unavailable (database error)." };
  }
  if (!ok) {
    return { error: "Incorrect username or password." };
  }
  redirect("/admin");
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/");
}

// ── Admin user management ────────────────────────────────────────────────────

export async function createUserAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  try {
    await requireAuth();
    const username = String(formData.get("username") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    await createUser(username, password);
    revalidatePath("/admin");
    return { ok: true };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to create user.",
    };
  }
}

export async function changePasswordAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  try {
    await requireAuth();
    const username = String(formData.get("username") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    await changePassword(username, password);
    revalidatePath("/admin");
    return { ok: true };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Failed to change password.",
    };
  }
}

export async function deleteUserAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  try {
    await requireAuth();
    const username = String(formData.get("username") ?? "").trim();
    const current = await getSessionUsername();
    if (current && current === username) {
      return { error: "You can't delete the account you're signed in as." };
    }
    await deleteUser(username);
    revalidatePath("/admin");
    return { ok: true };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to delete user.",
    };
  }
}

// Builds a clean data object from submitted form fields, applying NULL for
// empty optional fields and skipping auto-increment / control fields.
function buildData(
  columns: ColumnMeta[],
  formData: FormData,
  options: { includePrimaryKey: boolean }
): Record<string, unknown> {
  const primaryKey = getPrimaryKey(columns);
  const data: Record<string, unknown> = {};

  for (const column of columns) {
    if (column.isAutoIncrement) continue;
    if (!options.includePrimaryKey && column.name === primaryKey) continue;
    if (!formData.has(`field_${column.name}`)) continue;

    const raw = formData.get(`field_${column.name}`);
    const value = typeof raw === "string" ? raw : "";

    if (value === "" && column.nullable) {
      data[column.name] = null;
    } else {
      data[column.name] = value;
    }
  }
  return data;
}

async function requireAuth(): Promise<void> {
  if (!(await isAuthed())) {
    throw new Error("Unauthorized");
  }
}

export async function updateEntryAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  try {
    await requireAuth();
    const table = String(formData.get("__table") ?? "");
    const id = String(formData.get("__id") ?? "");
    const columns = await getColumns(table);
    const primaryKey = getPrimaryKey(columns);
    if (!primaryKey) {
      return { error: "This table has no primary key, so it can't be edited." };
    }
    const data = buildData(columns, formData, { includePrimaryKey: false });
    await updateRow(table, primaryKey, id, data);
    invalidateAll();
    revalidatePath("/admin");
    return { ok: true };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to save changes.",
    };
  }
}

export async function addEntryAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  try {
    await requireAuth();
    const table = String(formData.get("__table") ?? "");
    const columns = await getColumns(table);
    const data = buildData(columns, formData, { includePrimaryKey: true });

    // Adding a project also creates a matching table (cloned from brain_juice)
    // and stores that table's name on the row.
    let projectTableName = "";
    if (table === PROJECTS_TABLE) {
      const name = typeof data.name === "string" ? data.name.trim() : "";
      const provided =
        typeof data.table_name === "string" ? data.table_name.trim() : "";
      projectTableName = slugifyTableName(provided || name);
      if (name && projectTableName) {
        data.table_name = projectTableName;
      } else {
        projectTableName = "";
      }
    }

    await insertRow(table, data);

    if (table === PROJECTS_TABLE && projectTableName) {
      await createTableLike(projectTableName, "brain_juice", {
        ifNotExists: true,
      });
    }

    invalidateAll();
    revalidatePath("/admin");
    return { ok: true };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to add entry.",
    };
  }
}

// Deletes a single row identified by table + primary-key value. Used by the
// "broken images" cleanup tool to remove DB rows whose files are missing.
export async function deleteImageRowAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  try {
    await requireAuth();
    const table = String(formData.get("__table") ?? "");
    const id = String(formData.get("__id") ?? "");
    const columns = await getColumns(table);
    const primaryKey = getPrimaryKey(columns);
    if (!primaryKey) {
      return { error: "This table has no primary key, so it can't be cleaned up." };
    }
    await deleteRow(table, primaryKey, id);
    invalidateAll();
    revalidatePath("/admin");
    return { ok: true };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to delete row.",
    };
  }
}

export async function createTableAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const name = String(formData.get("table_name") ?? "").trim();
  if (!name) {
    return { error: "Please enter a table name." };
  }
  try {
    await requireAuth();
    await createTableLike(name);
    // Creating a table also registers it as a project.
    await ensureProjectEntry(name);
    invalidateAll();
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to create table.",
    };
  }
  revalidatePath("/admin");
  redirect(
    `/admin?table=${encodeURIComponent(name)}&created=${encodeURIComponent(
      name
    )}`
  );
}

export async function setActiveAction(formData: FormData): Promise<void> {
  await requireAuth();
  const table = String(formData.get("__table") ?? "");
  const id = String(formData.get("__id") ?? "");
  const active = String(formData.get("__active") ?? "") === "1";
  const columns = await getColumns(table);
  const primaryKey = getPrimaryKey(columns);
  const activeColumn = getActiveColumn(columns);
  if (!primaryKey || !activeColumn) {
    return;
  }
  await setActive(table, primaryKey, id, active);
  invalidateAll();
  revalidatePath("/admin");
}

// ── GitHub issue reporting (admin-only) ──────────────────────────────────────

// Opens a GitHub issue populated with the admin-supplied title and (markdown)
// body. Requires an authenticated admin; the body is appended with a small
// attribution footer noting which admin filed it.
export async function createIssueAction(
  _prev: IssueFormState,
  formData: FormData
): Promise<IssueFormState> {
  try {
    await requireAuth();
    const title = String(formData.get("title") ?? "").trim();
    const body = String(formData.get("body") ?? "");
    if (!title) {
      return { error: "Please enter a title for the issue." };
    }
    if (!body.trim()) {
      return { error: "Please enter a description." };
    }

    const reporter = (await getSessionUsername()) ?? "an admin";
    const footer = `\n\n---\n_Filed from the admin dashboard by **${reporter}**._`;

    // Note: we intentionally don't attach a label — GitHub rejects the request
    // if the label doesn't already exist in the repo.
    const issue = await createIssue({
      title,
      body: body + footer,
    });
    return { ok: true, issueUrl: issue.url, issueNumber: issue.number };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to open issue.",
    };
  }
}
