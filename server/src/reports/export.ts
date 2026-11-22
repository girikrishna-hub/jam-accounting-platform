import PDFDocument from 'pdfkit';
import { strToU8, zipSync } from 'fflate';
import type { Statement } from '@governedai-labs/financial-statements-runtime';

/**
 * One table definition, two outputs: a PDF to print or send, and an Excel file to work with. Money cells
 * hold minor units (strings); PDF shows them as 1,234.56 with negatives in brackets, Excel as numbers with
 * that number format.
 */

export interface Column { label: string; money?: boolean; width?: number }
export type Cell = string | { money: string } | null;
export interface Row { cells: Cell[]; bold?: boolean; indent?: number; rule?: boolean }
export interface Table {
  entity: string; title: string; subtitle: string[]; columns: Column[]; rows: Row[]; footer?: string[];
  /** Shown large across the page, e.g. DRAFT. */
  marking?: string | null;
  fileName: string;
}

export const money = (minor: string | bigint): Cell => ({ money: minor.toString() });

export function formatMoney(minor: string): string {
  const neg = minor.startsWith('-');
  const digits = (neg ? minor.slice(1) : minor).padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const text = `${whole}.${digits.slice(-2)}`;
  return neg ? `(${text})` : text;
}

const cellText = (c: Cell) => (c === null ? '' : typeof c === 'string' ? c : formatMoney(c.money));

// ---------- PDF ----------

export async function tablePdf(t: Table): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `${t.entity} – ${t.title}`, Producer: 'Accounting Platform' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const left = doc.page.margins.left;
  const usable = doc.page.width - left - doc.page.margins.right;
  const numeric = t.columns.filter((c) => c.money || c.width);
  const fixed = numeric.reduce((s, c) => s + (c.width ?? 88), 0);
  const firstWidth = Math.max(140, usable - fixed - (t.columns.length - 1 - numeric.length) * 90);
  const widths = t.columns.map((c, i) => (i === 0 ? firstWidth : c.width ?? (c.money ? 88 : 90)));
  const xs = widths.reduce<number[]>((acc, w, i) => [...acc, i === 0 ? left : acc[i - 1]! + widths[i - 1]!], []);
  const bottom = doc.page.height - doc.page.margins.bottom - 24;

  const header = () => {
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#000').text(t.entity, left, doc.page.margins.top);
    doc.fontSize(12).text(t.title);
    doc.font('Helvetica').fontSize(9).fillColor('#444');
    for (const s of t.subtitle) doc.text(s);
    if (t.marking) {
      doc.save().font('Helvetica-Bold').fontSize(60).fillColor('#d33').opacity(0.12)
        .text(t.marking, left, doc.page.height / 2 - 40, { width: usable, align: 'center' }).restore();
      doc.opacity(1);
    }
    doc.moveDown(0.6).fillColor('#000');
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9);
    t.columns.forEach((c, i) => doc.text(c.label, xs[i]!, y, { width: widths[i]! - 6, align: c.money ? 'right' : 'left' }));
    doc.moveTo(left, doc.y + 2).lineTo(left + usable, doc.y + 2).lineWidth(0.6).strokeColor('#000').stroke();
    doc.y += 5;
  };
  header();
  for (const r of t.rows) {
    doc.font(r.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    const indent = (r.indent ?? 0) * 12;
    const h = Math.max(...r.cells.map((c, i) => doc.heightOfString(cellText(c) || ' ', { width: widths[i]! - 6 - (i === 0 ? indent : 0) })));
    if (doc.y + h > bottom) { doc.addPage(); header(); doc.font(r.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9); }
    if (r.rule) { doc.moveTo(xs[1] ?? left, doc.y).lineTo(left + usable, doc.y).lineWidth(0.4).strokeColor('#666').stroke(); doc.y += 3; }
    const y = doc.y;
    r.cells.forEach((c, i) => doc.text(cellText(c), xs[i]! + (i === 0 ? indent : 0), y, { width: widths[i]! - 6 - (i === 0 ? indent : 0), align: t.columns[i]?.money ? 'right' : 'left' }));
    doc.y = y + h + 3;
  }
  if (t.footer?.length) {
    doc.moveDown(0.8).font('Helvetica').fontSize(8).fillColor('#555');
    for (const f of t.footer) doc.text(f, left, doc.y, { width: usable });
  }
  doc.end();
  return done;
}

// ---------- Excel ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)));
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Styles: 0 normal, 1 bold, 2 money, 3 money bold, 4–6 indented 1–3, 7 bold header right. */
const STYLES = `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;(#,##0.00)"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment indent="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment indent="2"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment indent="3"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

export function tableXlsx(t: Table): Buffer {
  const rows: string[] = [];
  let r = 0;
  const text = (ref: string, v: string, s = 0) => `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  const add = (cells: string[]) => { r += 1; rows.push(`<row r="${r}">${cells.join('')}</row>`); };
  add([text(`A${r + 1}`, t.entity, 1)]);
  add([text(`A${r + 1}`, t.title, 1)]);
  for (const s of [...(t.marking ? [t.marking] : []), ...t.subtitle]) add([text(`A${r + 1}`, s)]);
  add([]);
  add(t.columns.map((c, i) => text(`${colName(i)}${r + 1}`, c.label, c.money ? 7 : 1)));
  for (const row of t.rows) {
    const n = r + 1;
    add(row.cells.map((c, i) => {
      const ref = `${colName(i)}${n}`;
      if (c === null) return '';
      if (typeof c === 'string') return text(ref, c, i === 0 && row.indent ? 3 + Math.min(row.indent, 3) : row.bold ? 1 : 0);
      const v = c.money.startsWith('-') ? `-${formatMoney(c.money.slice(1)).replace(/,/g, '')}` : formatMoney(c.money).replace(/,/g, '');
      return `<c r="${ref}" s="${row.bold ? 3 : 2}"><v>${v}</v></c>`;
    }));
  }
  if (t.footer?.length) { add([]); for (const f of t.footer) add([text(`A${r + 1}`, f)]); }
  const cols = t.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${i === 0 ? 48 : c.money ? 18 : 22}" customWidth="1"/>`).join('');
  const sheet = `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`;
  const name = esc(t.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    '_rels/.rels': strToU8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
    'xl/styles.xml': strToU8(STYLES),
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}

// ---------- Statements as tables ----------

const longDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** A statement as a table: each line, with its accounts listed under mapped lines. */
export function statementTable(s: Statement, opts: { issueNumber?: number; replacedBy?: number | null; verified?: string | null }): Table {
  const c = s.content;
  const p = c.parameters;
  const pl = p.statementType === 'profitAndLoss';
  const title = pl ? 'Statement of profit or loss' : 'Statement of financial position';
  const hasCmp = Boolean(p.comparative);
  const columns: Column[] = [{ label: 'Line' }, { label: pl ? `${longDate(p.startDate!)} to ${longDate(p.endDate!)}` : `At ${longDate(p.date!)}`, money: true, width: 110 }];
  if (hasCmp) columns.push({ label: p.comparative!.date ? `At ${longDate(p.comparative!.date)}` : 'Comparative', money: true, width: 110 });
  const rows: Row[] = [];
  for (const line of c.lines) {
    const total = line.kind === 'subtotal' || (line.kind === 'derived' && line.depth === 0);
    rows.push({ cells: [line.label, money(line.amount), ...(hasCmp ? [line.comparativeAmount ? money(line.comparativeAmount) : null] : [])], bold: total, indent: line.depth, rule: total });
    if (line.kind === 'mapped' && line.accounts.length > 1) {
      for (const a of line.accounts) {
        rows.push({ cells: [`${a.code} ${a.name}`, money(a.amount), ...(hasCmp ? [a.comparativeAmount ? money(a.comparativeAmount) : null] : [])], indent: line.depth + 1 });
      }
    }
  }
  const marking = opts.issueNumber ? (opts.replacedBy ? `REPLACED BY ISSUE ${opts.replacedBy}` : null) : 'DRAFT';
  return {
    entity: c.entityName, title, marking, fileName: `${c.entityName} ${title} ${pl ? p.endDate : p.date}${opts.issueNumber ? ` issue ${opts.issueNumber}` : ' DRAFT'}`,
    subtitle: [
      `${c.currency}${pl ? `, ${longDate(p.startDate!)} to ${longDate(p.endDate!)}` : `, at ${longDate(p.date!)}`}`,
      opts.issueNumber ? `Issued statement no. ${opts.issueNumber}${s.metadata.issuedAt ? `, ${s.metadata.issuedAt.slice(0, 10)}` : ''}${s.metadata.replacesIssue ? ` (replaces no. ${s.metadata.replacesIssue}: ${s.metadata.reason ?? ''})` : ''}` : 'Draft – not issued; figures may change until the month is closed.',
      `Layout: ${c.layout.layoutId.startsWith('template:') ? c.layout.layoutId : 'practice layout'} v${c.layout.version}`,
    ],
    columns, rows,
    footer: [`Content fingerprint (SHA-256): ${s.contentSha256}`, ...(opts.verified ? [opts.verified] : [])],
  };
}
