import type { Role } from '../../../shared/workspace-model.ts';

/**
 * Which roles may perform each ledger runtime operation (design pack, Phase 3 matrix).
 * `system` is the firm administrator creating a client's books. This table is data only:
 * it is compiled into Authorization Runtime policies (access/authority.ts), which decide.
 */
export type LedgerPrincipal = Role | 'system';

const READ_ALL: readonly LedgerPrincipal[] = ['accountant', 'reviewer', 'client_viewer'];
const STAFF: readonly LedgerPrincipal[] = ['accountant', 'reviewer'];
const PREPARER: readonly LedgerPrincipal[] = ['accountant'];
const REVIEWER: readonly LedgerPrincipal[] = ['reviewer'];

export const LEDGER_POLICY: Readonly<Record<string, readonly LedgerPrincipal[]>> = {
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
  'bookkeeping.ListEntries': READ_ALL,
  'bookkeeping.GetAccountBalance': READ_ALL,
  'bookkeeping.GetAccountLedger': READ_ALL,
  'bookkeeping.GetTrialBalance': READ_ALL,
  'bookkeeping.GetPostedLines': READ_ALL,
  'bookkeeping.ListEvents': [],
  'bookkeeping.ListAuditRecords': READ_ALL,
};

export class AccessDenied extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'AccessDenied';
  }
}
