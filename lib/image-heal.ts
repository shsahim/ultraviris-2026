import "server-only";
import { query } from "@/lib/db";
import { escapeId } from "@/lib/admin-db";

// Self-healing is on by default; set IMAGE_AUTOHEAL=0/false to disable writing
// corrected File_Location values back to the database from read paths.
function autohealEnabled(): boolean {
  const flag = process.env.IMAGE_AUTOHEAL;
  if (flag === undefined || flag === "") return true;
  return /^(1|true|yes|on)$/i.test(flag);
}

/**
 * Fire-and-forget correction of a stored File_Location once the resolver has
 * found the real object under a different key (e.g. a missing/mismatched
 * extension). Best-effort by design: it never awaits into the caller and never
 * throws, so a failed write can't break image rendering.
 *
 * `table`, `idColumn`, and `fileColumn` are always schema-derived identifiers
 * (validated upstream); they're additionally backtick-escaped here.
 */
export function healFileLocation(params: {
  table: string;
  idColumn: string;
  id: string | number;
  fileColumn: string;
  corrected: string;
}): void {
  const { table, idColumn, id, fileColumn, corrected } = params;
  if (!autohealEnabled()) return;
  if (!table || !idColumn || !fileColumn || id == null || !corrected) return;

  void query(
    `UPDATE ${escapeId(table)} SET ${escapeId(fileColumn)} = ? WHERE ${escapeId(
      idColumn
    )} = ?`,
    [corrected, id]
  ).catch(() => {
    // Intentionally swallowed: corrections are opportunistic.
  });
}
