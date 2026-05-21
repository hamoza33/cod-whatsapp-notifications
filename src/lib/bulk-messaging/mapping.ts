import { normalizePhoneNumber } from "../phone";

/**
 * Column-mapping describes how an uploaded sheet's columns map onto the
 * pieces of a WhatsApp template send: one column for the recipient phone,
 * an optional column for a display name (only used in the status table),
 * and one entry per template body variable.
 *
 * Each variable mapping is either:
 *   • `column: <sheet column>` — read from that column for each row
 *   • `literal: <string>`      — same value for every row
 * If both are blank, the variable resolves to "" (the "missing variables
 * are OK, fall through with blank" UX rule).
 *
 * Optional `headerColumn` / `headerLiteral` lets the operator parametrize
 * the template header (e.g. tracking number / link).
 */
export interface VariableMapping {
  column: string | null;
  literal: string | null;
}

export interface ColumnMapping {
  phoneColumn: string;
  nameColumn: string | null;
  variableColumns: VariableMapping[];
  headerColumn?: string | null;
  headerLiteral?: string | null;
}

export interface ResolvedRow {
  rowIndex: number;
  phoneRaw: string;
  phoneNormalized: string | null;
  phoneError: string | null;
  displayName: string | null;
  variables: string[];
  headerValue: string | null;
}

/**
 * Resolve a parsed sheet of rows against a column-mapping. Each row gets a
 * normalized phone (or `phoneError` if the column was blank / unparseable),
 * a list of body variables (always length === bodyParamCount), an optional
 * header value, and the original row index for ordering.
 */
export function resolveRows(
  rows: Array<Record<string, string>>,
  mapping: ColumnMapping,
  bodyParamCount: number,
  defaultCountryCode: string
): ResolvedRow[] {
  const variableSlots = mapping.variableColumns.slice(0, bodyParamCount);
  // Pad with empty mappings so the output length always matches the
  // template's expected body-param count.
  while (variableSlots.length < bodyParamCount) {
    variableSlots.push({ column: null, literal: null });
  }

  return rows.map((row, idx) => {
    const phoneRaw = (row[mapping.phoneColumn] ?? "").trim();
    let phoneNormalized: string | null = null;
    let phoneError: string | null = null;
    if (!phoneRaw) {
      phoneError = "Phone column is empty for this row";
    } else {
      try {
        phoneNormalized = normalizePhoneNumber(phoneRaw, defaultCountryCode);
      } catch (err) {
        phoneError = err instanceof Error ? err.message : "Invalid phone number";
      }
    }

    const displayName = mapping.nameColumn
      ? (row[mapping.nameColumn] ?? "").trim() || null
      : null;

    const variables = variableSlots.map((slot) => resolveVariable(slot, row));

    const headerValue = resolveHeader(mapping, row);

    return {
      rowIndex: idx,
      phoneRaw,
      phoneNormalized,
      phoneError,
      displayName,
      variables,
      headerValue,
    };
  });
}

function resolveVariable(
  slot: VariableMapping,
  row: Record<string, string>
): string {
  if (slot.column) {
    const value = (row[slot.column] ?? "").trim();
    if (value) return value;
  }
  if (slot.literal) return slot.literal;
  return "";
}

function resolveHeader(
  mapping: ColumnMapping,
  row: Record<string, string>
): string | null {
  if (mapping.headerColumn) {
    const value = (row[mapping.headerColumn] ?? "").trim();
    if (value) return value;
  }
  if (mapping.headerLiteral) return mapping.headerLiteral;
  return null;
}

/**
 * De-duplicate resolved rows by normalized phone number. Keeps the first
 * occurrence; later duplicates are marked with `duplicateOf` so the
 * preview UI can surface them.
 */
export function markDuplicates(
  resolved: ResolvedRow[]
): Array<ResolvedRow & { duplicateOf: number | null }> {
  const seen = new Map<string, number>();
  return resolved.map((r) => {
    if (!r.phoneNormalized) return { ...r, duplicateOf: null };
    const firstAt = seen.get(r.phoneNormalized);
    if (firstAt !== undefined) {
      return { ...r, duplicateOf: firstAt };
    }
    seen.set(r.phoneNormalized, r.rowIndex);
    return { ...r, duplicateOf: null };
  });
}
