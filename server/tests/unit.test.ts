import { describe, expect, it } from 'vitest';
import { formatMinor, parseAmount } from '../src/domain/money.ts';
import { parseCsv } from '../src/domain/csv.ts';
import { parseChartOfAccounts } from '../src/domain/chart-of-accounts.ts';
import { planOpeningBalances } from '../src/domain/opening-balances.ts';
import { issueDecision, makeDecisionVerifier } from '../src/access/decisions.ts';
import { AccessAuthority, buildPolicies, type AccessQuestion } from '../src/access/authority.ts';
import { checkPassword, hashPassword, verifyPassword } from '../src/auth/passwords.ts';
import { addDays, endOfMonth } from '../src/services/books.ts';

describe('money', () => {
  it('parses amounts without floating point', () => {
    expect(parseAmount('8452310.55')).toBe(845231055n);
    expect(parseAmount('1,234.5')).toBe(123450n);
    expect(parseAmount('(1,234.56)')).toBe(-123456n);
    expect(parseAmount('J$8,075')).toBe(807500n);
    expect(parseAmount('0.001')).toBeNull();
    expect(parseAmount('500k')).toBeNull();
    expect(parseAmount('')).toBeNull();
  });
  it('formats minor units', () => {
    expect(formatMinor('45528993510')).toBe('455,289,935.10');
    expect(formatMinor(-5n)).toBe('-0.05');
    expect(formatMinor(0n)).toBe('0.00');
  });
});

describe('csv', () => {
  it('handles quotes, commas and CRLF', () => {
    expect(parseCsv('a,"b, c","d ""e"""\r\n1,2,3\r\n')).toEqual([['a', 'b, c', 'd "e"'], ['1', '2', '3']]);
  });
});

describe('chart of accounts', () => {
  const header = 'Account code,Account name,Type,Reporting group,Normal balance,Classification\n';
  it('maps types and normal balances', () => {
    const { rows, errors } = parseChartOfAccounts(header + '1000,Cash,Asset,Current assets,Dr,BS.CA.CASH.OFFICE\n4000,Fees,Revenue,Fees,Cr,PL.REV.FEES\n1130,Provision,Asset,Current assets,Cr,\n');
    expect(errors).toEqual([]);
    expect(rows.map((r) => [r.code, r.type, r.normalBalance, r.classification])).toEqual([
      ['1000', 'asset', 'debit', 'BS.CA.CASH.OFFICE'], ['4000', 'income', 'credit', 'PL.REV.FEES'], ['1130', 'asset', 'credit', null],
    ]);
  });
  it('refuses to guess', () => {
    const { errors } = parseChartOfAccounts(header + '1000,Cash,Thing,,Dr,\n4000,Fees,Revenue,,Cr,BS.CA.CASH\n1000,Dup,Asset,,Dr,\n');
    expect(errors.map((e) => e.line)).toEqual([2, 3]);
    const dup = parseChartOfAccounts(header + '1000,Cash,Asset,,Dr,\n1000,Dup,Asset,,Dr,\n');
    expect(dup.errors[0]?.message).toMatch(/Duplicate/);
  });
});

describe('opening balances', () => {
  const ids = new Map([['1000', 'a1'], ['3000', 'a2'], ['1130', 'a3']]);
  it('nets each account and requires balance', () => {
    const plan = planOpeningBalances('Account code,Debit (JMD),Credit (JMD)\n1000,100.00,0.00\n1130,0,25.50\n3000,0,74.50\n', ids);
    expect(plan.errors).toEqual([]);
    expect(plan.lines).toEqual([
      { accountId: 'a1', side: 'debit', amount: '10000', memo: 'Opening balance' },
      { accountId: 'a3', side: 'credit', amount: '2550', memo: 'Opening balance' },
      { accountId: 'a2', side: 'credit', amount: '7450', memo: 'Opening balance' },
    ]);
  });
  it('rejects an unbalanced file and unknown accounts', () => {
    expect(planOpeningBalances('Account code,Debit,Credit\n1000,100,0\n3000,0,99.99\n', ids).errors[0]?.message).toMatch(/does not balance/);
    expect(planOpeningBalances('Account code,Debit,Credit\n9999,1,0\n', ids).errors[0]?.message).toMatch(/not in the chart/);
  });
});

describe('authorization decisions', () => {
  const key = 'k'.repeat(40);
  const verify = makeDecisionVerifier(key);
  const now = new Date();
  const request = (over: Partial<{ operation: string; scope: string | null; actorId: string; now: string }> = {}) => ({
    operation: 'bookkeeping.PostEntry', scope: 'led_1', actorId: 'u1', now: now.toISOString(), summary: {}, ...over,
  });
  const decision = issueDecision(key, { actorId: 'u1', operation: 'bookkeeping.PostEntry', ledgerId: 'led_1', now });

  it('accepts its own decision for the exact request', async () => {
    expect(await verify(decision, request())).toEqual({ allowed: true });
  });
  it('rejects tampering, other ledgers, other actors, other operations and expiry', async () => {
    expect(await verify({ ...decision, ledgerId: 'led_2' }, request({ scope: 'led_2' }))).toMatchObject({ allowed: false, reason: 'EVIDENCE_INVALID' });
    expect(await verify(decision, request({ scope: 'led_2' }))).toMatchObject({ allowed: false, reason: 'SCOPE_MISMATCH' });
    expect(await verify(decision, request({ actorId: 'u2' }))).toMatchObject({ allowed: false, reason: 'ACTOR_MISMATCH' });
    expect(await verify(decision, request({ operation: 'bookkeeping.ReverseEntry' }))).toMatchObject({ allowed: false });
    expect(await verify(decision, request({ now: new Date(now.getTime() + 120_000).toISOString() }))).toMatchObject({ allowed: false, reason: 'EXPIRED' });
    const foreign = issueDecision('x'.repeat(40), { actorId: 'u1', operation: 'bookkeeping.PostEntry', ledgerId: 'led_1', now });
    expect(await verify(foreign, request())).toMatchObject({ allowed: false, reason: 'EVIDENCE_INVALID' });
  });
});

describe('access authority (Authorization Runtime)', () => {
  const authority = new AccessAuthority('firm');
  const base: AccessQuestion = {
    userId: 'u1', role: 'accountant', assignedOrganisationId: 'orgA', resourceType: 'ledger', resourceId: 'led-a',
    resourceOrganisationId: 'orgA', action: 'bookkeeping.PostEntry',
  };
  const decide = async (over: Partial<AccessQuestion>) => (await authority.decide({ ...base, ...over })).allowed;

  it('allows an accountant to post in their own client only', async () => {
    expect(await decide({})).toBe(true);
    expect(await decide({ resourceOrganisationId: 'orgB' })).toBe(false);
    expect(await decide({ assignedOrganisationId: 'orgB' })).toBe(false);
  });
  it('keeps client viewers read-only', async () => {
    expect(await decide({ role: 'client_viewer', action: 'bookkeeping.GetTrialBalance' })).toBe(true);
    for (const action of ['bookkeeping.CreateAccount', 'bookkeeping.PostEntry', 'bookkeeping.OpenPeriod', 'bookkeeping.ReverseEntry', 'bookkeeping.ClosePeriod']) {
      expect(await decide({ role: 'client_viewer', action }), action).toBe(false);
    }
    expect(await decide({ role: 'client_viewer', resourceType: 'client-organisation', resourceId: 'orgA', action: 'coa.import' })).toBe(false);
    expect(await decide({ role: 'client_viewer', resourceType: 'client-organisation', resourceId: 'orgA', action: 'capability.periods.view' })).toBe(false);
    expect(await decide({ role: 'client_viewer', resourceType: 'client-organisation', resourceId: 'orgA', action: 'capability.trial-balance.view' })).toBe(true);
  });
  it('reserves ledger creation and administration for firm administrators; reviewers close periods', async () => {
    expect(await decide({ action: 'bookkeeping.CreateLedger' })).toBe(false);
    expect(await decide({ role: 'firm_admin', assignedOrganisationId: null, action: 'bookkeeping.CreateLedger' })).toBe(true);
    expect(await decide({ resourceType: 'firm', resourceId: 'firm', resourceOrganisationId: null, action: 'admin.users.create' })).toBe(false);
    expect(await decide({ role: 'firm_admin', assignedOrganisationId: null, resourceType: 'firm', resourceId: 'firm', resourceOrganisationId: null, action: 'admin.users.create' })).toBe(true);
    expect(await decide({ role: 'reviewer', action: 'bookkeeping.ClosePeriod' })).toBe(true);
    expect(await decide({ action: 'bookkeeping.ClosePeriod' })).toBe(false);
    expect(await decide({ action: 'bookkeeping.Unknown' })).toBe(false);
  });
  it('binds every policy to the firm and denies an unknown role', async () => {
    const policies = buildPolicies('firm');
    expect(policies.every((p) => p.conditions.some((c) => c.type === 'tenant'))).toBe(true);
    expect(await decide({ role: 'nobody' as AccessQuestion['role'] })).toBe(false);
  });
});

describe('passwords (Authentication Runtime)', () => {
  it('applies the password rule', () => {
    expect(checkPassword('Correct-Horse-Battery-42').ok).toBe(true);
    expect(checkPassword('short1A').ok).toBe(false);
    expect(checkPassword('alllowercase-123').ok).toBe(false);
    expect(checkPassword('NoDigitsHereAtAll').ok).toBe(false);
  });
  it('hashes and verifies', () => {
    const hash = hashPassword('Correct-Horse-Battery-42');
    expect(verifyPassword('Correct-Horse-Battery-42', hash)).toBe(true);
    expect(verifyPassword('Correct-Horse-Battery-43', hash)).toBe(false);
    expect(verifyPassword('anything', 'not-a-hash')).toBe(false);
  });
});

describe('dates', () => {
  it('computes month ends and next days in UTC', () => {
    expect(endOfMonth('2026-02-01')).toBe('2026-02-28');
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
  });
});
