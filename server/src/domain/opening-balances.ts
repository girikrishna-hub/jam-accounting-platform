import type { LineInput } from '@governedai-labs/bookkeeping-runtime';
import { parseCsv, rowsByHeader } from './csv.ts';
import { formatMinor, parseAmount } from './money.ts';
import type { RowError } from './chart-of-accounts.ts';

export interface OpeningBalancePlan {
  readonly lines: LineInput[];
  readonly totalDebits: bigint;
  readonly totalCredits: bigint;
  readonly errors: RowError[];
}

/**
 * Turns a trial balance CSV (Account code, Debit, Credit) into opening-balance lines.
 * Each account's net goes on its debit or credit side; zero rows are skipped.
 * The totals must agree to the cent, or nothing is posted.
 */
export function planOpeningBalances(csvText: string, accountIdByCode: ReadonlyMap<string, string>): OpeningBalancePlan {
  const { records, missing } = rowsByHeader(parseCsv(csvText), {
    code: ['Account code', 'Code'],
    debit: ['Debit'],
    credit: ['Credit'],
  });
  if (missing.length) return { lines: [], totalDebits: 0n, totalCredits: 0n, errors: [{ line: 1, message: `Missing column(s): ${missing.join(', ')}` }] };

  const lines: LineInput[] = [];
  const errors: RowError[] = [];
  let totalDebits = 0n;
  let totalCredits = 0n;
  const seen = new Set<string>();
  records.forEach((r, i) => {
    const line = i + 2;
    const code = r.code ?? '';
    if (!code) return;
    const debit = parseAmount(r.debit || '0');
    const credit = parseAmount(r.credit || '0');
    if (debit === null || credit === null || debit < 0n || credit < 0n) return void errors.push({ line, message: `Account ${code}: amounts must be positive numbers with at most 2 decimals` });
    if (seen.has(code)) return void errors.push({ line, message: `Account ${code} appears twice` });
    seen.add(code);
    const accountId = accountIdByCode.get(code);
    if (!accountId) return void errors.push({ line, message: `Account ${code} is not in the chart of accounts` });
    totalDebits += debit;
    totalCredits += credit;
    const net = debit - credit;
    if (net === 0n) return;
    lines.push({ accountId, side: net > 0n ? 'debit' : 'credit', amount: (net > 0n ? net : -net).toString(), memo: 'Opening balance' });
  });
  if (!errors.length && totalDebits !== totalCredits) {
    errors.push({ line: 0, message: `Trial balance does not balance: debits ${formatMinor(totalDebits)}, credits ${formatMinor(totalCredits)}` });
  }
  if (!errors.length && lines.length === 0) errors.push({ line: 0, message: 'No non-zero balances to post' });
  return { lines: errors.length ? [] : lines, totalDebits, totalCredits, errors };
}
