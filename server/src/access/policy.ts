import type { Role } from '../../../shared/workspace-model.ts';

/**
 * Which roles may perform each ledger runtime operation (design pack, Phase 3 matrix).
 * `system` is the server acting for the firm administrator when a client is created.
 * Anything not listed is refused.
 */
export type Principal = Role | 'system';

const READ_ALL: readonly Principal[] = ['accountant', 'reviewer', 'client_viewer'];
const STAFF: readonly Principal[] = ['accountant', 'reviewer'];
const PREPARER: readonly Principal[] = ['accountant'];
const REVIEWER: readonly Principal[] = ['reviewer'];

export const LEDGER_POLICY: Readonly<Record<string, readonly Principal[]>> = {
  'bookkeeping.CreateLedger': ['system'],
  'bookkeeping.SuspendLedger': ['system'],
  'bookkeeping.ResumeLedger': ['system'],
  'bookkeeping.ArchiveLedger': ['system'],
  'bookkeeping.CreateAccount': PREPARER,
  'bookkeeping.UpdateAccount': PREPARER,
  'bookkeeping.DeactivateAccount': PREPARER,
  'bookkeeping.OpenPeriod': PREPARER,
  'bookkeeping.ClosePeriod': REVIEWER,
  'bookkeeping.ReopenPeriod': REVIEWER,
  'bookkeeping.PostOpeningBalances': PREPARER,
  'bookkeeping.DraftEntry': PREPARER,
  'bookkeeping.UpdateDraft': PREPARER,
  'bookkeeping.DiscardDraft': PREPARER,
  'bookkeeping.PostEntry': PREPARER,
  'bookkeeping.ReverseEntry': PREPARER,
  'bookkeeping.GetLedger': READ_ALL,
  'bookkeeping.ListAccounts': READ_ALL,
  'bookkeeping.ListPeriods': STAFF,
  'bookkeeping.GetEntry': READ_ALL,
  'bookkeeping.GetAccountBalance': READ_ALL,
  'bookkeeping.GetAccountLedger': READ_ALL,
  'bookkeeping.GetTrialBalance': READ_ALL,
  'bookkeeping.GetPostedLines': READ_ALL,
  'bookkeeping.ListEvents': [],
  'bookkeeping.ListAuditRecords': READ_ALL,
};

export function mayPerform(principal: Principal, operation: string): boolean {
  return (LEDGER_POLICY[operation] ?? []).includes(principal);
}

export class AccessDenied extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'AccessDenied';
  }
}
