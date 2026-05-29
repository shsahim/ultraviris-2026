"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  checkPassword,
  createSession,
  destroySession,
  isAuthed,
} from "@/lib/auth";
import {
  createTableLike,
  getActiveColumn,
  getColumns,
  getPrimaryKey,
  insertRow,
  setActive,
  updateRow,
  type ColumnMeta,
} from "@/lib/admin-db";

export interface FormState {
  ok?: boolean;
  error?: string;
}

export async function loginAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const password = String(formData.get("password") ?? "");
  if (!checkPassword(password)) {
    return { error: "Incorrect password." };
  }
  await createSession();
  redirect("/admin");
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/admin");
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
    await insertRow(table, data);
    revalidatePath("/admin");
    return { ok: true };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to add entry.",
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
  revalidatePath("/admin");
}
