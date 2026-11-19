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
  type EntryView,
  type LedgerView,
  type LineInput,
  type Page,
  type PeriodView,
  type Side,
  type TrialBalance,
} from '@governedai-labs/bookkeeping-runtime';
import { PostgresStorage } from '@governedai-labs/bookkeeping-runtime-postgres';
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
    return new LedgerGateway(runtime, signingKey, access);
  }

  /** Drains the runtime's event outbox (no consumers yet). */
  dispatchEvents(): Promise<unknown> {
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

  listPeriods(a: LedgerActor): Promise<PeriodView[]> {
    return this.all(async (cursor) => this.runtime.listPeriods({ ...await this.query(a, 'bookkeeping.ListPeriods'), cursor }));
  }

  // ---- Entries ----

  async postOpeningBalances(a: LedgerActor, lines: LineInput[], requestId?: string): Promise<EntryView> {
    return this.runtime.postOpeningBalances({ ...await this.command(a, 'bookkeeping.PostOpeningBalances', requestId), lines });
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
}
