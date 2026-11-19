/** Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF or LF, optional BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

/** Maps rows to objects by header, matching header names case-insensitively and ignoring "(JMD)"-style suffixes. */
export function rowsByHeader(rows: string[][], wanted: Record<string, string[]>): { records: Record<string, string>[]; missing: string[] } {
  const [header, ...body] = rows;
  if (!header) return { records: [], missing: Object.keys(wanted) };
  const norm = (h: string) => h.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const index: Record<string, number> = {};
  const missing: string[] = [];
  for (const [key, names] of Object.entries(wanted)) {
    const i = header.findIndex((h) => names.map(norm).includes(norm(h)));
    if (i >= 0) index[key] = i; else missing.push(key);
  }
  const records = body.map((r) => Object.fromEntries(Object.entries(index).map(([k, i]) => [k, (r[i] ?? '').trim()])));
  return { records, missing };
}
