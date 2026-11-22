import { randomUUID } from 'node:crypto';
import {
  BookkeepingRuntime,
  CallbackEventPublisher,
  SystemClock,
  VerifierAuthorization,
  type AccountLedgerLine,
  type AccountType,
  type AccountView,
  type AuditRecordView,
  type EntryKind,
  type EntryState,
  type EntrySummary,
  type EntryView,
  type LedgerView,
  type LineInput,
  type Page,
  type PeriodView,
  type Side,
  type TrialBalance,
} from '@governedai-labs/bookkeeping-runtime';
import { PostgresStorage } from '@governedai-labs/bookkeeping-runtime-postgres';
import {
  CallbackEventPublisher as StatementsEvents,
  FinancialStatementsRuntime,
  RuntimeError as StatementsError,
  SystemClock as StatementsClock,
  VerifierAuthorization as StatementsVerifier,
  type IssuedStatement,
  type IssuedStatementSummary,
  type LayoutLine,
  type Statement,
  type StatementType,
  type Verification,
} from '@governedai-labs/financial-statements-runtime';
import { PostgresStorage as StatementsStorage } from '@governedai-labs/financial-statements-runtime-postgres';
import { BookkeepingLedgerSource } from '@governedai-labs/financial-statements-bookkeeping-source';
import { BusinessRuleError } from '../services/rule-error.ts';
import type pg from 'pg';
import { issueDecision, makeDecisionVerifier } from '../access/decisions.ts';
import { AccessDenied } from '../access/policy.ts';
import { FIRM_ADMIN, type AccessAuthority } from '../access/authority.ts';
import type { Role } from '../../../shared/workspace-model.ts';

/** Who is acting, in which role, on which client's ledger. Resolved by the org-scope middleware. */
export interface LedgerActor {
  readonly actorId: string;
  readonly sessionRef?: string;
  readonly principal: Role;
  /** The client the role was granted for. */
  readonly assignedOrganisationId: string;
  /** The client that owns the ledger, from the organisation record. */
  readonly organisationId: string;
  readonly ledgerId: string;
}

/**
 * The only path from the app to the Bookkeeping runtime.
 *
 * Every call: (1) asks the Authorization Runtime (through AccessAuthority) whether this user,
 * in this role and client, may perform the operation on this ledger, (2) issues a signed
 * decision for exactly that operation, ledger and user, (3) calls the runtime with a fresh
 * request ID unless the caller supplies one for a retry. Ledger IDs always come from the
 * organisation record, never from the request.
 */
export class LedgerGateway {
  private statementsRuntime: FinancialStatementsRuntime | null = null;

  constructor(private readonly runtime: BookkeepingRuntime, private readonly signingKey: string, private readonly access: AccessAuthority) {}

  static async create(pool: pg.Pool, signingKey: string, access: AccessAuthority): Promise<LedgerGateway> {
    const storage = new PostgresStorage({ pool, schema: 'bookkeeping' });
    await storage.migrate();
    const runtime = new BookkeepingRuntime({
      storage,
      // Release 1 has no event consumers; the outbox is drained periodically.
      events: new CallbackEventPublisher(() => undefined),
      authorization: new VerifierAuthorization(makeDecisionVerifier(signingKey)),
      clock: new SystemClock(),
    });
    const gateway = new LedgerGateway(runtime, signingKey, access);
    // The statements runtime reads the ledger through this gateway's Bookkeeping instance. It asks only for
    // the four reads it needs; each statements call is first authorised for the user (statementsDecide), so
    // these reads are issued to the statements service principal.
    const statementsStorage = new StatementsStorage({ pool, schema: 'financial_statements' });
    await statementsStorage.migrate();
    gateway.statementsRuntime = new FinancialStatementsRuntime({
      storage: statementsStorage,
      events: new StatementsEvents(() => undefined),
      authorization: new StatementsVerifier(makeDecisionVerifier(signingKey)),
      clock: new StatementsClock(),
      ledgerSource: new BookkeepingLedgerSource({
        bookkeeping: runtime as never,
        readDecision: (operation, ledgerId) => issueDecision(signingKey, { actorId: STATEMENTS_SERVICE, operation, ledgerId }),
      }),
    });
    return gateway;
  }

  /** Drains the runtime's event outbox (no consumers yet). */
  async dispatchEvents(): Promise<unknown> {
    await this.statementsRuntime?.dispatchEvents();
    return this.runtime.dispatchEvents();
  }

  private async decide(a: LedgerActor, operation: string) {
    const answer = await this.access.decide({
      userId: a.actorId,
      ...(a.sessionRef ? { sessionRef: a.sessionRef } : {}),
      role: a.principal,
      assignedOrganisationId: a.assignedOrganisationId,
      resourceType: 'ledger',
      resourceId: a.ledgerId,
      resourceOrganisationId: a.organisationId,
      action: operation,
      auditDenial: true,
    });
    if (!answer.allowed) throw new AccessDenied(`${operation}: ${answer.decision}`);
    return issueDecision(this.signingKey, { actorId: a.actorId, operation, ledgerId: a.ledgerId });
  }

  private async command(a: LedgerActor, operation: string, requestId?: string) {
    return { requestId: requestId ?? randomUUID(), ledgerId: a.ledgerId, decision: await this.decide(a, operation) };
  }

  private async query(a: LedgerActor, operation: string) {
    return { ledgerId: a.ledgerId, decision: await this.decide(a, operation) };
  }

  private async all<T>(fetch: (cursor: string | null) => Promise<Page<T>>): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 1000; guard += 1) {
      const page: Page<T> = await fetch(cursor);
      items.push(...page.items);
      cursor = page.nextCursor ?? null;
      if (!cursor) return items;
    }
    throw new Error('Too many pages');
  }

  // ---- Ledger lifecycle (system principal, on client creation) ----

  /** Firm administrators only. Idempotent: the org's stored request ID makes a retry return the same ledger. */
  async createLedger(adminId: string, input: { requestId: string; orgId: string; name: string; currency: string; openingDate: string }): Promise<LedgerView> {
    const answer = await this.access.decide({
      userId: adminId, role: FIRM_ADMIN, assignedOrganisationId: null,
      resourceType: 'ledger', resourceId: `new:${input.orgId}`, resourceOrganisationId: input.orgId, action: 'bookkeeping.CreateLedger', auditDenial: true,
    });
    if (!answer.allowed) throw new AccessDenied(`bookkeeping.CreateLedger: ${answer.decision}`);
    return this.runtime.createLedger({
      requestId: input.requestId,
      decision: issueDecision(this.signingKey, { actorId: adminId, operation: 'bookkeeping.CreateLedger', ledgerId: null }),
      name: input.name,
      ownerReference: input.orgId,
      currency: input.currency,
      decimalPlaces: 2,
      openingDate: input.openingDate,
    });
  }

  // ---- Accounts ----

  async createAccount(a: LedgerActor, input: { code: string; name: string; type: AccountType; normalBalance?: Side; classification?: string | null }, requestId?: string): Promise<AccountView> {
    return this.runtime.createAccount({ ...await this.command(a, 'bookkeeping.CreateAccount', requestId), ...input });
  }

  async updateAccount(a: LedgerActor, input: { accountId: string; name?: string; classification?: string }): Promise<AccountView> {
    return this.runtime.updateAccount({ ...await this.command(a, 'bookkeeping.UpdateAccount'), ...input });
  }

  async deactivateAccount(a: LedgerActor, accountId: string): Promise<AccountView> {
    return this.runtime.deactivateAccount({ ...await this.command(a, 'bookkeeping.DeactivateAccount'), accountId });
  }

  listAccounts(a: LedgerActor): Promise<AccountView[]> {
    return this.all(async (cursor) => this.runtime.listAccounts({ ...await this.query(a, 'bookkeeping.ListAccounts'), cursor }));
  }

  // ---- Periods ----

  async openPeriod(a: LedgerActor, startDate: string, endDate: string): Promise<PeriodView> {
    return this.runtime.openPeriod({ ...await this.command(a, 'bookkeeping.OpenPeriod'), startDate, endDate });
  }

  async closePeriod(a: LedgerActor, periodId: string, requestId?: string): Promise<PeriodView> {
    return this.runtime.closePeriod({ ...await this.command(a, 'bookkeeping.ClosePeriod', requestId), periodId });
  }

  async reopenPeriod(a: LedgerActor, periodId: string, reason: string, requestId?: string): Promise<PeriodView> {
    return this.runtime.reopenPeriod({ ...await this.command(a, 'bookkeeping.ReopenPeriod', requestId), periodId, reason });
  }

  listPeriods(a: LedgerActor): Promise<PeriodView[]> {
    return this.all(async (cursor) => this.runtime.listPeriods({ ...await this.query(a, 'bookkeeping.ListPeriods'), cursor }));
  }

  // ---- Entries ----

  async postOpeningBalances(a: LedgerActor, lines: LineInput[], requestId?: string): Promise<EntryView> {
    return this.runtime.postOpeningBalances({ ...await this.command(a, 'bookkeeping.PostOpeningBalances', requestId), lines });
  }

  async draftEntry(a: LedgerActor, input: { entryDate: string; description: string; externalReference?: string; lines: LineInput[] }, requestId?: string): Promise<EntryView> {
    return this.runtime.draftEntry({ ...await this.command(a, 'bookkeeping.DraftEntry', requestId), ...input });
  }

  async updateDraft(a: LedgerActor, input: { entryId: string; entryDate: string; description: string; externalReference?: string; lines: LineInput[]; expectedVersion?: number }): Promise<EntryView> {
    return this.runtime.updateDraft({ ...await this.command(a, 'bookkeeping.UpdateDraft'), ...input });
  }

  async discardDraft(a: LedgerActor, entryId: string): Promise<EntryView> {
    return this.runtime.discardDraft({ ...await this.command(a, 'bookkeeping.DiscardDraft'), entryId });
  }

  /** With expectedVersion the runtime posts only that version of the entry, else Conflict ENTRY_VERSION_MISMATCH (BR-28). */
  async postEntry(a: LedgerActor, entryId: string, requestId?: string, expectedVersion?: number): Promise<EntryView> {
    return this.runtime.postEntry({ ...await this.command(a, 'bookkeeping.PostEntry', requestId), entryId, ...(expectedVersion != null ? { expectedVersion } : {}) });
  }

  async reverseEntry(a: LedgerActor, input: { entryId: string; reversalDate: string; reason: string }, requestId?: string): Promise<EntryView> {
    return this.runtime.reverseEntry({ ...await this.command(a, 'bookkeeping.ReverseEntry', requestId), ...input });
  }

  async getEntry(a: LedgerActor, entryId: string): Promise<EntryView> {
    return this.runtime.getEntry({ ...await this.query(a, 'bookkeeping.GetEntry'), entryId });
  }

  /** Every entry of the ledger as a summary (no lines), in entry-date then creation order. */
  listEntries(a: LedgerActor, filter: { states?: EntryState[]; kinds?: EntryKind[]; fromDate?: string; toDate?: string } = {}): Promise<EntrySummary[]> {
    return this.all(async (cursor) => this.runtime.listEntries({ ...await this.query(a, 'bookkeeping.ListEntries'), ...filter, cursor }));
  }

  // ---- Reporting reads ----

  async getLedger(a: LedgerActor): Promise<LedgerView> {
    return this.runtime.getLedger(await this.query(a, 'bookkeeping.GetLedger'));
  }

  async getTrialBalance(a: LedgerActor, asOf?: string): Promise<TrialBalance> {
    return this.runtime.getTrialBalance({ ...await this.query(a, 'bookkeeping.GetTrialBalance'), asOf: asOf ?? null });
  }

  getAccountLedger(a: LedgerActor, accountId: string, fromDate: string, toDate: string): Promise<AccountLedgerLine[]> {
    return this.all(async (cursor) => this.runtime.getAccountLedger({ ...await this.query(a, 'bookkeeping.GetAccountLedger'), accountId, fromDate, toDate, cursor }));
  }

  /** Whether an opening journal is posted. It is always the ledger's first posting, so one small page suffices. */
  async hasOpeningBalances(a: LedgerActor): Promise<boolean> {
    const page = await this.runtime.getPostedLines({ ...await this.query(a, 'bookkeeping.GetPostedLines'), fromSequence: 1, toSequence: 1 });
    return page.items.some((line) => line.entryKind === 'opening');
  }

  listAuditRecords(a: LedgerActor): Promise<AuditRecordView[]> {
    return this.all(async (cursor) => this.runtime.listAuditRecords({ ...await this.query(a, 'bookkeeping.ListAuditRecords'), afterSequence: 0, cursor }));
  }

  // ---- Statements (FinancialStatementsRuntime) ----

  private get fs(): FinancialStatementsRuntime {
    if (!this.statementsRuntime) throw new Error('Statements runtime not started');
    return this.statementsRuntime;
  }

  /** Runs a statements call, turning the runtime's business errors into messages the screens can show. */
  private async statements<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (e) {
      if (!(e instanceof StatementsError)) throw e;
      const code = e.code as string;
      if (code === 'NotAuthorized') throw new AccessDenied(`statements: ${e.reason ?? ''}`);
      const message = STATEMENT_MESSAGES[code];
      if (message) throw new BusinessRuleError(code, typeof message === 'function' ? message(e.details) : message, e.details);
      throw e;
    }
  }

  async statementsRegistered(a: LedgerActor): Promise<boolean> {
    try {
      await this.fs.getLedgerSettings({ ...await this.query(a, 'financialStatements.GetLedgerSettings') });
      return true;
    } catch (e) {
      if (e instanceof StatementsError && (e.code as string) === 'LedgerNotRegistered') return false;
      throw e;
    }
  }

  /** Registers the ledger for statements and saves its layouts as the defaults. Safe to repeat. */
  async registerStatements(a: LedgerActor, input: { entityName: string; financialYearStartMonth: number; layouts: Record<StatementType, { name: string; lines: LayoutLine[] }> }): Promise<void> {
    if (!(await this.statementsRegistered(a))) {
      await this.statements(async () => this.fs.registerLedger({ ...await this.command(a, 'financialStatements.RegisterLedger', `fs-register:${a.ledgerId}`), entityName: input.entityName, financialYearStartMonth: input.financialYearStartMonth }));
    }
    for (const statementType of ['profitAndLoss', 'balanceSheet'] as const) {
      const wanted = input.layouts[statementType];
      const existing = (await this.statements(async () => this.fs.listLayouts({ ...await this.query(a, 'financialStatements.ListLayouts'), statementType }))).items
        .find((l) => !l.template && l.name === wanted.name);
      if (existing) continue;
      const saved = await this.statements(async () => this.fs.saveLayout({ ...await this.command(a, 'financialStatements.SaveLayout', `fs-layout:${a.ledgerId}:${statementType}:${wanted.name}`), statementType, name: wanted.name, lines: wanted.lines }));
      await this.statements(async () => this.fs.setDefaultLayout({ ...await this.command(a, 'financialStatements.SetDefaultLayout', `fs-default:${a.ledgerId}:${statementType}:${wanted.name}`), statementType, layoutId: saved.layoutId, layoutVersion: saved.version }));
    }
  }

  async generateProfitAndLoss(a: LedgerActor, startDate: string, endDate: string): Promise<Statement> {
    return this.statements(async () => this.fs.generateProfitAndLoss({ ...await this.query(a, 'financialStatements.GenerateProfitAndLoss'), startDate, endDate }));
  }

  async generateBalanceSheet(a: LedgerActor, date: string, comparativeDate?: string): Promise<Statement> {
    return this.statements(async () => this.fs.generateBalanceSheet({ ...await this.query(a, 'financialStatements.GenerateBalanceSheet'), date, ...(comparativeDate ? { comparative: { date: comparativeDate } } : {}) }));
  }

  async issueStatement(a: LedgerActor, input: { statementType: StatementType; startDate?: string; endDate?: string; date?: string; comparativeDate?: string; replacesIssue?: number; reason?: string }, requestId?: string): Promise<IssuedStatement> {
    const { comparativeDate, ...rest } = input;
    return this.statements(async () => this.fs.issueStatement({ ...await this.command(a, 'financialStatements.IssueStatement', requestId), ...rest, ...(comparativeDate ? { comparative: { date: comparativeDate } } : {}) }));
  }

  async listIssuedStatements(a: LedgerActor): Promise<IssuedStatementSummary[]> {
    return this.all(async (cursor) => this.statements(async () => this.fs.listIssuedStatements({ ...await this.query(a, 'financialStatements.ListIssuedStatements'), ...(cursor ? { cursor } : {}) })));
  }

  async getIssuedStatement(a: LedgerActor, statementType: StatementType, issueNumber: number): Promise<IssuedStatement> {
    return this.statements(async () => this.fs.getIssuedStatement({ ...await this.query(a, 'financialStatements.GetIssuedStatement'), statementType, issueNumber }));
  }

  async verifyIssuedStatement(a: LedgerActor, statementType: StatementType, issueNumber: number): Promise<Verification> {
    return this.statements(async () => this.fs.verifyIssuedStatement({ ...await this.query(a, 'financialStatements.VerifyIssuedStatement'), statementType, issueNumber }));
  }
}

/** The principal the statements runtime's Bookkeeping reads are issued to. */
export const STATEMENTS_SERVICE = 'service:financial-statements';

const STATEMENT_MESSAGES: Record<string, string | ((details: unknown) => string)> = {
  PeriodsOpen: 'A statement can only be issued once every month it covers is closed.',
  UnmappedAccounts: (d) => `Some accounts are not on the statement layout: ${JSON.stringify(d)}.`,
  InvalidPeriod: 'A profit and loss must fall within one financial year and inside the books.',
  StatementDoesNotBalance: 'The statement does not balance. Please report this.',
  LedgerDataInvalid: 'The ledger data could not be read for a statement. Please report this.',
  ReissueMismatch: 'A replacement must cover the same statement and dates as the one it replaces.',
  IssuedStatementNotFound: 'That issued statement does not exist.',
  LedgerNotRegistered: 'Statements are not set up for this client yet.',
  InvalidLayout: (d) => `The statement layout is not valid: ${JSON.stringify(d)}.`,
};
