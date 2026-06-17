// Shared admin UI types — safe to import from Client Components (no DB/SSH).

export interface ColumnMeta {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
}

export type Row = Record<string, unknown>;
