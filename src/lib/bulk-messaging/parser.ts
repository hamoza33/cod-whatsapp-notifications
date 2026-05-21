import ExcelJS from "exceljs";

/**
 * Result of parsing an uploaded sheet. Every row is a string-keyed record
 * matching the column headers — values are stringified on parse so the
 * downstream column-mapping UI doesn't have to deal with mixed types.
 */
export interface ParsedSheet {
  columns: string[];
  rows: Array<Record<string, string>>;
  totalRows: number;
  truncated: boolean;
  format: "csv" | "xlsx";
}

const MAX_ROWS = 10_000;

/**
 * Parse a CSV byte buffer into headers + row objects. Handles RFC-4180-style
 * double-quoted fields with embedded commas, escaped quotes ("") and CRLF
 * line endings. Whitespace around values is preserved (the column-mapping
 * UI shows raw values so the operator can spot leading/trailing junk).
 */
export function parseCsvBuffer(bytes: ArrayBuffer): ParsedSheet {
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      // Treat \r\n as one newline; the \n branch on the next iteration is a
      // no-op because row is already empty.
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      // Skip fully empty rows that arise from trailing blank lines.
      if (row.length > 1 || row[0].trim() !== "") {
        records.push(row);
      }
      row = [];
      continue;
    }
    field += ch;
  }
  // Flush trailing field/row if the file didn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0].trim() !== "") {
      records.push(row);
    }
  }

  if (records.length === 0) {
    return { columns: [], rows: [], totalRows: 0, truncated: false, format: "csv" };
  }

  const rawHeaders = records[0].map((h) => h.trim());
  const columns = dedupeColumnNames(rawHeaders);
  const dataRows = records.slice(1);
  const truncated = dataRows.length > MAX_ROWS;
  const limited = truncated ? dataRows.slice(0, MAX_ROWS) : dataRows;
  const rows = limited.map((rec) => rowToRecord(columns, rec));

  return {
    columns,
    rows,
    totalRows: dataRows.length,
    truncated,
    format: "csv",
  };
}

/**
 * Parse an XLSX byte buffer. Uses the first worksheet, treats row 1 as
 * headers, and stringifies all cell values (so dates become ISO strings and
 * numbers become their decimal representation).
 */
export async function parseXlsxBuffer(bytes: ArrayBuffer): Promise<ParsedSheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    return { columns: [], rows: [], totalRows: 0, truncated: false, format: "xlsx" };
  }

  const headerRow = worksheet.getRow(1);
  const rawHeaders: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell) => {
    rawHeaders.push(stringifyCell(cell.value));
  });
  // Trim trailing empty header cells so we don't render dozens of fake columns.
  while (rawHeaders.length > 0 && rawHeaders[rawHeaders.length - 1].trim() === "") {
    rawHeaders.pop();
  }
  const columns = dedupeColumnNames(rawHeaders.map((h) => h.trim()));

  const allRows: string[][] = [];
  const lastRow = worksheet.actualRowCount ?? worksheet.rowCount;
  for (let r = 2; r <= lastRow; r++) {
    const row = worksheet.getRow(r);
    const out: string[] = new Array(columns.length).fill("");
    let nonEmpty = false;
    for (let c = 1; c <= columns.length; c++) {
      const val = stringifyCell(row.getCell(c).value);
      out[c - 1] = val;
      if (val.trim() !== "") nonEmpty = true;
    }
    if (nonEmpty) allRows.push(out);
  }

  const truncated = allRows.length > MAX_ROWS;
  const limited = truncated ? allRows.slice(0, MAX_ROWS) : allRows;
  const rows = limited.map((rec) => rowToRecord(columns, rec));

  return {
    columns,
    rows,
    totalRows: allRows.length,
    truncated,
    format: "xlsx",
  };
}

function rowToRecord(
  columns: string[],
  rec: string[]
): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i]] = (rec[i] ?? "").toString();
  }
  return obj;
}

function dedupeColumnNames(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h, idx) => {
    const base = h.trim() || `column_${idx + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base} (${count + 1})`;
  });
}

/** ExcelJS cell values are a union of string / number / Date / hyperlink /
 *  rich-text — flatten everything to a plain string so the column-mapping
 *  UI doesn't have to differentiate.
 */
function stringifyCell(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    // Hyperlink: { text, hyperlink }
    if ("text" in value && typeof (value as { text?: unknown }).text === "string") {
      return (value as { text: string }).text;
    }
    // Rich text: { richText: [{ text }, …] }
    if ("richText" in value && Array.isArray((value as { richText?: unknown }).richText)) {
      const parts = (value as { richText: Array<{ text?: string }> }).richText;
      return parts.map((p) => p.text ?? "").join("");
    }
    // Formula cell: { formula, result }
    if ("result" in value) {
      return stringifyCell((value as { result?: ExcelJS.CellValue }).result ?? null);
    }
    // SharedFormula / Error / fallback
    if ("error" in value && typeof (value as { error?: unknown }).error === "string") {
      return "";
    }
  }
  return String(value);
}
