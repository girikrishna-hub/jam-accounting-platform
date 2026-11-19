import type { AccountType, Side } from '@governedai-labs/bookkeeping-runtime';
import { parseCsv, rowsByHeader } from './csv.ts';

export interface AccountRow {
  readonly line: number;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly normalBalance: Side;
  readonly reportingGroup: string;
  readonly classification: string | null;
}

export interface RowError {
  readonly line: number;
  readonly message: string;
}

const TYPES: Record<string, AccountType> = {
  asset: 'asset', assets: 'asset',
  liability: 'liability', liabilities: 'liability',
  equity: 'equity', capital: 'equity',
  revenue: 'income', income: 'income',
  expense: 'expense', expenses: 'expense',
};

const NATURAL_SIDE: Record<AccountType, Side> = { asset: 'debit', expense: 'debit', liability: 'credit', equity: 'credit', income: 'credit' };

/** Statement classification codes: PL.* for income/expense, BS.* for the rest (statements runtime namespaces). */
const CLASSIFICATION = /^(PL|BS)(\.[A-Z0-9_]+){1,5}$/;

/**
 * Parses a chart-of-accounts CSV (columns: Account code, Account name, Type, Normal balance,
 * optional Reporting group and Classification). Nothing is guessed: an unknown type or a
 * malformed classification is an error on that line; a missing classification stays empty
 * and is shown as "unclassified" until an accountant sets it.
 */
export function parseChartOfAccounts(csvText: string): { rows: AccountRow[]; errors: RowError[] } {
  const { records, missing } = rowsByHeader(parseCsv(csvText), {
    code: ['Account code', 'Code'],
    name: ['Account name', 'Name'],
    type: ['Type', 'Account type'],
    normal: ['Normal balance'],
    group: ['Reporting group'],
    classification: ['Classification', 'Statement classification'],
  });
  const required = ['code', 'name', 'type'].filter((k) => missing.includes(k));
  if (required.length) return { rows: [], errors: [{ line: 1, message: `Missing column(s): ${required.join(', ')}` }] };

  const rows: AccountRow[] = [];
  const errors: RowError[] = [];
  const seen = new Set<string>();
  records.forEach((r, i) => {
    const line = i + 2;
    const code = r.code ?? '';
    const name = r.name ?? '';
    const type = TYPES[(r.type ?? '').toLowerCase()];
    if (!/^[A-Za-z0-9.-]{1,20}$/.test(code)) return errors.push({ line, message: `Invalid account code "${code}"` });
    if (seen.has(code)) return errors.push({ line, message: `Duplicate account code ${code}` });
    if (!name || name.length > 200) return errors.push({ line, message: `Account ${code}: name is required (max 200 characters)` });
    if (!type) return errors.push({ line, message: `Account ${code}: unknown type "${r.type}"` });
    const normalText = (r.normal ?? '').toLowerCase();
    const normalBalance: Side | undefined = normalText === '' ? NATURAL_SIDE[type]
      : ['dr', 'debit'].includes(normalText) ? 'debit' : ['cr', 'credit'].includes(normalText) ? 'credit' : undefined;
    if (!normalBalance) return errors.push({ line, message: `Account ${code}: normal balance must be Dr or Cr` });
    const classification = r.classification ? r.classification : null;
    if (classification) {
      if (!CLASSIFICATION.test(classification)) return errors.push({ line, message: `Account ${code}: invalid classification "${classification}"` });
      const expected = type === 'income' || type === 'expense' ? 'PL' : 'BS';
      if (!classification.startsWith(expected + '.')) return errors.push({ line, message: `Account ${code}: a ${type} account needs a ${expected}.* classification` });
    }
    seen.add(code);
    rows.push({ line, code, name, type, normalBalance, reportingGroup: r.group ?? '', classification });
    return undefined;
  });
  return { rows, errors };
}
