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
import { AccessDenied, mayPerform, type Principal } from '../access/policy.ts';

/** Who is acting, in which role, on which client's ledger. Resolved by the org-scope middleware. */
export interface LedgerActor {
  readonly actorId: string;
  readonly principal: Principal;
  readonly ledgerId: string;
}

/**
 * The only path from the app to the Bookkeeping runtime.
 *
 * Every call: (1) checks the policy for the actor's role, (2) issues a decision for exactly
 * that operation, ledger and actor, (3) calls the runtime with a fresh request ID unless
 * the caller supplies one for a retry. Ledger IDs always come from the organisation record,
 * never from the request.
 */
export class LedgerGateway {
  constructor(private readonly runtime: BookkeepingRuntime, private readonly signingKey: string) {}

  static async create(pool: pg.Pool, signingKey: string): Promise<LedgerGateway> {
    const storage = new PostgresStorage({ pool, schema: 'bookkeeping' });
    await storage.migrate();
    const runtime = new BookkeepingRuntime({
      storage,
      // Release 1 has no event consumers; the outbox is drained periodically.
      events: new CallbackEventPublisher(() => undefined),
      authorization: new VerifierAuthorization(makeDecisionVerifier(signingKey)),
      clock: new SystemClock(),
    });
    return new LedgerGateway(runtime, signingKey);
  }

  /** Drains the runtime's event outbox (no consumers yet). */
  dispatchEvents(): Promise<unknown> {
    return this.runtime.dispatchEvents();
  }

  private decide(actorId: string, principal: Principal, operation: string, ledgerId: string | null) {
    if (!mayPerform(principal, operation)) throw new AccessDenied(`${principal} may not perform ${operation}`);
    return issueDecision(this.signingKey, { actorId, operation, ledgerId });
  }

  private command(a: LedgerActor, operation: string, requestId?: string) {
    return { requestId: requestId ?? randomUUID(), ledgerId: a.ledgerId, decision: this.decide(a.actorId, a.principal, operation, a.ledgerId) };
  }

  private query(a: LedgerActor, operation: string) {
    return { ledgerId: a.ledgerId, decision: this.decide(a.actorId, a.principal, operation, a.ledgerId) };
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

  /** Idempotent: the org's stored request ID makes a retry return the same ledger. */
  createLedger(actorId: string, input: { requestId: string; orgId: string; name: string; currency: string; openingDate: string }): Promise<LedgerView> {
    return this.runtime.createLedger({
      requestId: input.requestId,
      decision: this.decide(actorId, 'system', 'bookkeeping.CreateLedger', null),
      name: input.name,
      ownerReference: input.orgId,
      currency: input.currency,
      decimalPlaces: 2,
      openingDate: input.openingDate,
    });
  }

  // ---- Accounts ----

  createAccount(a: LedgerActor, input: { code: string; name: string; type: AccountType; normalBalance?: Side; classification?: string | null }, requestId?: string): Promise<AccountView> {
    return this.runtime.createAccount({ ...this.command(a, 'bookkeeping.CreateAccount', requestId), ...input });
  }

  updateAccount(a: LedgerActor, input: { accountId: string; name?: string; classification?: string }): Promise<AccountView> {
    return this.runtime.updateAccount({ ...this.command(a, 'bookkeeping.UpdateAccount'), ...input });
  }

  deactivateAccount(a: LedgerActor, accountId: string): Promise<AccountView> {
    return this.runtime.deactivateAccount({ ...this.command(a, 'bookkeeping.DeactivateAccount'), accountId });
  }

  listAccounts(a: LedgerActor): Promise<AccountView[]> {
    return this.all((cursor) => this.runtime.listAccounts({ ...this.query(a, 'bookkeeping.ListAccounts'), cursor }));
  }

  // ---- Periods ----

  openPeriod(a: LedgerActor, startDate: string, endDate: string): Promise<PeriodView> {
    return this.runtime.openPeriod({ ...this.command(a, 'bookkeeping.OpenPeriod'), startDate, endDate });
  }

  listPeriods(a: LedgerActor): Promise<PeriodView[]> {
    return this.all((cursor) => this.runtime.listPeriods({ ...this.query(a, 'bookkeeping.ListPeriods'), cursor }));
  }

  // ---- Entries ----

  postOpeningBalances(a: LedgerActor, lines: LineInput[], requestId?: string): Promise<EntryView> {
    return this.runtime.postOpeningBalances({ ...this.command(a, 'bookkeeping.PostOpeningBalances', requestId), lines });
  }

  // ---- Reporting reads ----

  getLedger(a: LedgerActor): Promise<LedgerView> {
    return this.runtime.getLedger(this.query(a, 'bookkeeping.GetLedger'));
  }

  getTrialBalance(a: LedgerActor, asOf?: string): Promise<TrialBalance> {
    return this.runtime.getTrialBalance({ ...this.query(a, 'bookkeeping.GetTrialBalance'), asOf: asOf ?? null });
  }

  getAccountLedger(a: LedgerActor, accountId: string, fromDate: string, toDate: string): Promise<AccountLedgerLine[]> {
    return this.all((cursor) => this.runtime.getAccountLedger({ ...this.query(a, 'bookkeeping.GetAccountLedger'), accountId, fromDate, toDate, cursor }));
  }

  /** Whether an opening journal is posted. It is always the ledger's first posting, so one small page suffices. */
  async hasOpeningBalances(a: LedgerActor): Promise<boolean> {
    const page = await this.runtime.getPostedLines({ ...this.query(a, 'bookkeeping.GetPostedLines'), fromSequence: 1, toSequence: 1 });
    return page.items.some((line) => line.entryKind === 'opening');
  }

  listAuditRecords(a: LedgerActor): Promise<AuditRecordView[]> {
    return this.all((cursor) => this.runtime.listAuditRecords({ ...this.query(a, 'bookkeeping.ListAuditRecords'), afterSequence: 0, cursor }));
  }
}
