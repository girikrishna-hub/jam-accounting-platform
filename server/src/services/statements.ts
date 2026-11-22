import { z } from 'zod';
import type { IssuedStatement, LayoutLine, Statement, StatementType } from '@governedai-labs/financial-statements-runtime';
import type { OrgScope } from '../http/middleware.ts';
import { audit } from '../audit.ts';
import { BusinessRuleError } from './rule-error.ts';
import type { Ctx } from './documents.ts';

/**
 * Financial statements (Slice 5) through the Financial Statements runtime: a profit and loss by nature
 * ending at "net profit available for appropriation", and a balance sheet financed by partners' funds,
 * following the sample year-end statements. Each line lists its accounts, so practice areas show under
 * fee income. Drafts are generated on demand; issuing needs every month covered to be closed.
 */

const m = (code: string, label: string, depth: number, side: 'debit' | 'credit', ...patterns: string[]): LayoutLine => ({ code, label, depth, kind: 'mapped', side, patterns });
const t = (code: string, label: string, depth: number, side: 'debit' | 'credit', ...terms: string[]): LayoutLine => ({
  code, label, depth, kind: 'subtotal', side, terms: terms.map((x) => (x.startsWith('-') ? { line: x.slice(1), sign: 'minus' as const } : { line: x, sign: 'plus' as const })),
});

export const LAYOUT_NAMES = { profitAndLoss: 'Profit and loss – practice (v1)', balanceSheet: 'Balance sheet – partnership (v1)' } as const;

export const PRACTICE_LAYOUTS: Record<StatementType, { name: string; lines: LayoutLine[] }> = {
  profitAndLoss: {
    name: LAYOUT_NAMES.profitAndLoss,
    lines: [
      m('FEES', 'Fee income', 0, 'credit', 'PL.REV.*'),
      m('OTHER_INCOME', 'Other income', 0, 'credit', 'PL.OI.*', 'PL.FIN.INC.*'),
      t('TOTAL_INCOME', 'Total income', 0, 'credit', 'FEES', 'OTHER_INCOME'),
      m('STAFF', 'Staff costs', 0, 'debit', 'PL.EMP.*'),
      m('OVERHEADS', 'Premises, practice and administration', 0, 'debit', 'PL.OPEX.*', 'PL.MAT.*'),
      m('FINANCE', 'Finance costs', 0, 'debit', 'PL.FIN.EXP.*'),
      m('DEPRECIATION', 'Depreciation', 0, 'debit', 'PL.DEP.*'),
      t('TOTAL_EXPENSES', 'Total expenses', 0, 'debit', 'STAFF', 'OVERHEADS', 'FINANCE', 'DEPRECIATION'),
      t('NET_PROFIT', 'Net profit available for appropriation', 0, 'credit', 'TOTAL_INCOME', '-TOTAL_EXPENSES'),
    ],
  },
  balanceSheet: {
    name: LAYOUT_NAMES.balanceSheet,
    lines: [
      t('NCA', 'Non-current assets', 0, 'debit', 'PPE', 'NCA_OTHER'),
      m('PPE', 'Property, plant and equipment (net)', 1, 'debit', 'BS.NCA.PPE.*'),
      m('NCA_OTHER', 'Other non-current assets', 1, 'debit', 'BS.NCA.INT.*', 'BS.NCA.INV.*', 'BS.NCA.OTHER.*'),
      t('CA', 'Current assets', 0, 'debit', 'DEBTORS', 'WIP_FD', 'OTHER_REC', 'CASH', 'CA_OTHER', 'CLIENT_MONEY'),
      m('DEBTORS', 'Fee debtors (net of provision)', 1, 'debit', 'BS.CA.REC.FEES'),
      m('WIP_FD', 'Unbilled work in progress and short-term investment', 1, 'debit', 'BS.CA.OTHER.WIPFD'),
      m('OTHER_REC', 'Disbursements, prepayments and GCT recoverable', 1, 'debit', 'BS.CA.REC.OTHER'),
      m('CASH', 'Cash at bank and in hand (office)', 1, 'debit', 'BS.CA.CASH.*'),
      m('CA_OTHER', 'Other current assets', 1, 'debit', 'BS.CA.INV.*', 'BS.CA.OTHER.OTHER'),
      m('CLIENT_MONEY', "Clients' money held in trust", 1, 'debit', 'BS.CA.OTHER.CLIENTMONEY'),
      t('TOTAL_ASSETS', 'Total assets', 0, 'debit', 'NCA', 'CA'),
      t('CL', 'Current liabilities', 0, 'credit', 'PAYABLES', 'TAX_ACCRUALS', 'RETAINERS', 'CL_OTHER', 'CLIENT_LIAB'),
      m('PAYABLES', 'Trade payables', 1, 'credit', 'BS.CL.PAY.TRADE'),
      m('TAX_ACCRUALS', 'GCT, statutory deductions and accruals', 1, 'credit', 'BS.CL.PAY.OTHER', 'BS.CL.TAX.*'),
      m('RETAINERS', 'Retainers received in advance', 1, 'credit', 'BS.CL.OTHER.RETAINERS'),
      m('CL_OTHER', 'Other current liabilities', 1, 'credit', 'BS.CL.BORR.*', 'BS.CL.OTHER.OTHER'),
      m('CLIENT_LIAB', "Amounts owed to clients (clients' money)", 1, 'credit', 'BS.CL.OTHER.CLIENTMONEY'),
      t('NCL', 'Non-current liabilities', 0, 'credit', 'LOANS'),
      m('LOANS', 'Bank loans', 1, 'credit', 'BS.NCL.*'),
      t('TOTAL_LIABILITIES', 'Total liabilities', 0, 'credit', 'CL', 'NCL'),
      t('NET_ASSETS', 'Net assets', 0, 'debit', 'TOTAL_ASSETS', '-TOTAL_LIABILITIES'),
      t('PARTNERS', "Partners' funds", 0, 'credit', 'CAPITAL', 'CURRENT', 'PROFIT_BF', 'PROFIT_YEAR'),
      m('CAPITAL', 'Capital accounts', 1, 'credit', 'BS.EQ.CAP.*'),
      m('CURRENT', 'Current accounts (after drawings)', 1, 'credit', 'BS.EQ.CUR.*', 'BS.EQ.RES.*'),
      { code: 'PROFIT_BF', label: "Earlier years' profit not yet allocated", depth: 1, kind: 'derived', side: 'credit', derived: 'retainedEarningsBroughtForward' },
      { code: 'PROFIT_YEAR', label: 'Profit for the year to date (not yet allocated)', depth: 1, kind: 'derived', side: 'credit', derived: 'profitForYear' },
    ],
  },
};

/** Sets the client up for statements (once): registers the ledger and saves the practice layouts as defaults. */
export async function ensureStatements(ctx: Ctx, scope: OrgScope): Promise<boolean> {
  if (scope.role !== 'accountant') return ctx.ledger.statementsRegistered(scope.actor);
  await ctx.ledger.registerStatements(scope.actor, {
    entityName: scope.org.legal_name || scope.org.name,
    financialYearStartMonth: scope.org.financial_year_start || 1,
    layouts: PRACTICE_LAYOUTS,
  });
  return true;
}

export const monthStart = (end: string) => `${end.slice(0, 7)}-01`;
const dayBefore = (date: string) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

/** The balance sheet's comparative: the previous month end, or for the first month, the opening position. */
export function comparativeDate(scope: OrgScope, date: string): string {
  const previous = dayBefore(monthStart(date));
  return previous < scope.org.opening_date ? scope.org.opening_date : previous;
}

export const StatementQuery = z.object({ type: z.enum(['profitAndLoss', 'balanceSheet']), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** A draft statement for the month ending periodEnd. */
export async function draftStatement(ctx: Ctx, scope: OrgScope, type: StatementType, periodEnd: string): Promise<Statement> {
  if (!(await ensureStatements(ctx, scope))) throw new BusinessRuleError('LedgerNotRegistered', 'Statements are not set up for this client yet.');
  return type === 'profitAndLoss'
    ? ctx.ledger.generateProfitAndLoss(scope.actor, monthStart(periodEnd), periodEnd)
    : ctx.ledger.generateBalanceSheet(scope.actor, periodEnd, comparativeDate(scope, periodEnd));
}

export const IssueInput = z.object({
  type: z.enum(['profitAndLoss', 'balanceSheet']), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  replacesIssue: z.number().int().positive().optional(), reason: z.string().trim().max(500).optional(),
});

/** Issues a statement for a closed month. A statement already issued for the same month is replaced. */
export async function issueStatement(ctx: Ctx, scope: OrgScope, raw: unknown): Promise<IssuedStatement> {
  const input = IssueInput.parse(raw);
  await ensureStatements(ctx, scope);
  const params = input.type === 'profitAndLoss'
    ? { startDate: monthStart(input.periodEnd), endDate: input.periodEnd }
    : { date: input.periodEnd, comparativeDate: comparativeDate(scope, input.periodEnd) };
  const previous = (await ctx.ledger.listIssuedStatements(scope.actor)).filter((s) => s.statementType === input.type && !s.replacedBy
    && (input.type === 'profitAndLoss' ? s.parameters.endDate === input.periodEnd && s.parameters.startDate === params.startDate : s.parameters.date === input.periodEnd));
  const replaces = input.replacesIssue ?? previous[previous.length - 1]?.issueNumber;
  if (replaces && !input.reason) throw new BusinessRuleError('REASON_NEEDED', 'This statement has been issued before. Give a reason for issuing it again.');
  const issued = await ctx.ledger.issueStatement(scope.actor, {
    statementType: input.type, ...params, ...(replaces ? { replacesIssue: replaces, reason: input.reason! } : {}),
  });
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'statement.issue', target: `${input.type}:${issued.issueNumber}`, detail: { periodEnd: input.periodEnd, replaces: replaces ?? null } });
  return issued;
}
