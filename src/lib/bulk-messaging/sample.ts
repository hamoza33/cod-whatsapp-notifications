/**
 * Builds a small CSV sample the operator can download as a starting point.
 * Columns are deliberately chosen to mirror the kinds of variables a typical
 * order template uses (customer name, order id, tracking number, etc.) so
 * the operator can swap in their own values without re-thinking the layout.
 */
export function buildSampleCsv(): string {
  const headers = [
    "phone",
    "name",
    "order_id",
    "tracking_number",
    "delivery_company",
    "amount",
  ];
  const rows = [
    [
      "+212690123456",
      "Hamza Alaoui",
      "ORDER-001",
      "60123456789",
      "iMile",
      "299 MAD",
    ],
    [
      "0612345678",
      "Sara Bennani",
      "ORDER-002",
      "INJAZ.987654321",
      "Injaz",
      "450 MAD",
    ],
    [
      "00966501234567",
      "محمد العتيبي",
      "ORDER-003",
      "JTE9988776",
      "JTE",
      "199 SAR",
    ],
    [
      "+966555000111",
      "Ahmad Khan",
      "ORDER-004",
      "",
      "",
      "350 SAR",
    ],
  ];

  const escape = (v: string): string => {
    if (/[",\n\r]/.test(v)) {
      return `"${v.replace(/"/g, '""')}"`;
    }
    return v;
  };

  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(row.map(escape).join(","));
  }
  // Use CRLF so Excel opens it cleanly on Windows; tools that read LF only
  // (most Unix utilities) treat the trailing \r as whitespace.
  return lines.join("\r\n") + "\r\n";
}
