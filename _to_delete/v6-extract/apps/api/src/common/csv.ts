/** Quotes as RFC 4180 and neutralises spreadsheet formulas in free text; plain numbers (including negatives) pass through. */
export function csvCell(v: string): string {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
  return [header, ...rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))))].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export class CsvError extends Error {}

/**
 * RFC 4180 parser: quoted fields, doubled quotes, CRLF/LF, embedded newlines, optional BOM. Blank lines are skipped.
 * Throws CsvError for a quote that never closes, and when a row is wider than `maxColumns` or the file has more than `maxRows`.
 */
export function parseCsv(input: string, o: { maxRows?: number; maxColumns?: number } = {}): string[][] {
  const maxRows = o.maxRows ?? 10_000; const maxColumns = o.maxColumns ?? 100;
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = []; let row: string[] = []; let field = ''; let inQuotes = false; let wasQuoted = false;
  const endField = () => { row.push(field); field = ''; wasQuoted = false; if (row.length > maxColumns) throw new CsvError(`more than ${maxColumns} columns`); };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === '' )) { rows.push(row); if (rows.length > maxRows + 1) throw new CsvError(`more than ${maxRows} rows`); }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; } else field += ch;
    } else if (ch === '"' && field === '' && !wasQuoted) { inQuotes = true; wasQuoted = true; }
    else if (ch === ',') endField();
    else if (ch === '\n') endRow();
    else if (ch === '\r') { if (text[i + 1] === '\n') i++; endRow(); }
    else field += ch;
  }
  if (inQuotes) throw new CsvError('a quoted value is never closed');
  if (field !== '' || row.length > 0) endRow();
  return rows;
}
