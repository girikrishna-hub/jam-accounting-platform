import { randomUUID } from 'node:crypto';
import { RuntimeError, type EntryState, type EntrySummary, type EntryView, type LineInput } from '@governedai-labs/bookkeeping-runtime';
import { z } from 'zod';
import type { Db } from '../db/db.ts';
import type { LedgerGateway } from '../ledger/gateway.ts';
import type { OrgScope } from '../http/middleware.ts';
import { parseAmount } from '../domain/money.ts';
import { audit } from '../audit.ts';
import { BusinessRuleError } from './rule-error.ts';

/**
 * Journal workflow (design pack: journal approval = maker-checker, one handoff).
 *
 * The Bookkeeping runtime holds each journal and alone decides posting, balance and period
 * rules. The app adds the approval step and keeps a register of the workflow status and the
 * people involved, which the runtime does not track. Entries the app did not create (such as
 * the opening journal) are found with the runtime's ListEntries query and registered.
 *
 *   approval on : draft ─submit→ submitted ─approve→ approved ─post→ posted ─reverse→ reversed
 *                               └─return→ returned ─(edit, submit again)
 *   approval off: draft ─post→ posted
 *
 * The approver must be someone other than the preparer and submitter. Any edit after
 * approval sends the journal back to draft. Approval records the entry's version, and posting
 * passes it to the runtime, which refuses to post any other version (Bookkeeping BR-28).
 */

export type JournalStatus = 'draft' | 'submitted' | 'returned' | 'approved' | 'posted' | 'discarded' | 'reversed';
export type JournalKind = 'standard' | 'opening' | 'reversal';

export interface JournalRow {
  org_id: string;
  entry_id: string;
  kind: JournalKind;
  status: JournalStatus;
  entry_date: string;
  description: string;
  total_minor: string;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  submitted_by: string | null;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  approved_version: number | null;
  posted_by: string | null;
  posted_at: string | null;
  posting_sequence: number | null;
  reversal_of: string | null;
  reversed_by_entry: string | null;
  /** Set when a source document (fee note, receipt, credit note) posted this journal. */
  source_type: string | null;
  source_id: string | null;
}

const COLUMNS = `org_id, entry_id, kind, status, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, description, total_minor::text AS total_minor,
  created_by, created_at, updated_by, updated_at, submitted_by, submitted_at, reviewed_by, reviewed_at, review_note,
  approved_version, posted_by, posted_at, posting_sequence, reversal_of, reversed_by_entry, source_type, source_id`;

/** Statuses a journal can be edited, discarded or posted from. */
const EDITABLE: JournalStatus[] = ['draft', 'returned', 'approved'];
export const FINAL: JournalStatus[] = ['posted', 'discarded', 'reversed'];
/** What a client viewer may see: posted journals and their reversals. */
export const VISIBLE_TO_CLIENT: JournalStatus[] = ['posted', 'reversed'];

// ---------- Input ----------

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const LineSchema = z.object({
  accountId: z.string().min(1).max(128),
  debit: z.string().max(30).optional(),
  credit: z.string().max(30).optional(),
  memo: z.string().trim().max(500).optional(),
});
export const JournalInputSchema = z.object({
  entryDate: ISO_DATE,
  description: z.string().trim().min(1, 'Description is required').max(500),
  reference: z.string().trim().max(100).optional(),
  lines: z.array(LineSchema).min(2, 'A journal needs at least two lines').max(200),
});
export type JournalInput = z.infer<typeof JournalInputSchema>;

export interface ParsedJournal {
  entryDate: string;
  description: string;
  externalReference?: string;
  lines: LineInput[];
  totalDebits: bigint;
  totalCredits: bigint;
}

/** Each line has exactly one positive amount, debit or credit, with at most 2 decimals. */
export function parseJournalInput(raw: unknown): ParsedJournal {
  const input = JournalInputSchema.parse(raw);
  const errors: { line: number; message: string }[] = [];
  const lines: LineInput[] = [];
  let totalDebits = 0n;
  let totalCredits = 0n;
  input.lines.forEach((l, i) => {
    const n = i + 1;
    const debit = l.debit?.trim() ? parseAmount(l.debit) : 0n;
    const credit = l.credit?.trim() ? parseAmount(l.credit) : 0n;
    if (debit === null || credit === null) return void errors.push({ line: n, message: 'Amounts must be numbers with at most 2 decimals' });
    if (debit < 0n || credit < 0n) return void errors.push({ line: n, message: 'Amounts cannot be negative' });
    if ((debit > 0n) === (credit > 0n)) return void errors.push({ line: n, message: 'Enter a debit or a credit, not both or neither' });
    const amount = debit > 0n ? debit : credit;
    totalDebits += debit;
    totalCredits += credit;
    lines.push({ accountId: l.accountId, side: debit > 0n ? 'debit' : 'credit', amount: amount.toString(), ...(l.memo ? { memo: l.memo } : {}) });
  });
  if (errors.length) throw new BusinessRuleError('INVALID_LINES', 'Some lines need fixing.', errors);
  return {
    entryDate: input.entryDate,
    description: input.description,
    ...(input.reference ? { externalReference: input.reference } : {}),
    lines, totalDebits, totalCredits,
  };
}

function totals(entry: Pick<EntryView, 'lines'>) {
  let debits = 0n;
  let credits = 0n;
  for (const l of entry.lines) {
    if (l.side === 'debit') debits += BigInt(l.amount.amount); else credits += BigInt(l.amount.amount);
  }
  return { debits, credits };
}

// ---------- Register ----------

export async function getJournal(db: Db, orgId: string, entryId: string): Promise<JournalRow | null> {
  const r = await db.query<JournalRow>(`SELECT ${COLUMNS} FROM app.journals WHERE org_id = $1 AND entry_id = $2`, [orgId, entryId]);
  return r.rows[0] ?? null;
}

export async function listJournals(db: Db, orgId: string, statuses?: readonly JournalStatus[]): Promise<JournalRow[]> {
  const r = statuses
    ? await db.query<JournalRow>(`SELECT ${COLUMNS} FROM app.journals WHERE org_id = $1 AND status = ANY($2) ORDER BY entry_date DESC, created_at DESC LIMIT 500`, [orgId, statuses])
    : await db.query<JournalRow>(`SELECT ${COLUMNS} FROM app.journals WHERE org_id = $1 ORDER BY entry_date DESC, created_at DESC LIMIT 500`, [orgId]);
  return r.rows;
}

/**
 * Moves a journal between statuses only if it is still in one of the expected statuses,
 * so two people acting at once cannot both succeed.
 */
async function transition(db: Db, orgId: string, entryId: string, from: readonly JournalStatus[], set: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(set);
  const assignments = keys.map((k, i) => `${k} = $${i + 4}`).join(', ');
  const r = await db.query(
    `UPDATE app.journals SET ${assignments}, updated_at = now() WHERE org_id = $1 AND entry_id = $2 AND status = ANY($3)`,
    [orgId, entryId, from, ...keys.map((k) => set[k])]);
  if (!r.rowCount) throw new BusinessRuleError('JOURNAL_CHANGED', 'This journal was changed by someone else. Reload and try again.');
}

const STATUS_FROM_STATE: Record<EntryState, JournalStatus> = { draft: 'draft', discarded: 'discarded', posted: 'posted', reversed: 'reversed' };

/**
 * Registers any ledger entry the register does not know yet (for example an opening journal
 * posted before the register existed), using the runtime's entry list (Bookkeeping 1.2.0).
 */
export async function registerMissingEntries(db: Db, ledger: LedgerGateway, scope: OrgScope): Promise<void> {
  const known = new Set((await db.query<{ entry_id: string }>(`SELECT entry_id FROM app.journals WHERE org_id = $1`, [scope.org.id])).rows.map((r) => r.entry_id));
  const missing = (await ledger.listEntries(scope.actor)).filter((e) => !known.has(e.entryId));
  for (const e of missing) await registerSummary(db, scope.org.id, e);
}

async function registerSummary(db: Db, orgId: string, e: EntrySummary): Promise<void> {
  await db.query(
    `INSERT INTO app.journals (org_id, entry_id, kind, status, entry_date, description, total_minor, posting_sequence, reversal_of, reversed_by_entry)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (org_id, entry_id) DO NOTHING`,
    [orgId, e.entryId, e.kind, STATUS_FROM_STATE[e.state], e.entryDate, e.description, e.totalDebits.amount, e.postingSequence ?? null, e.reversalOf ?? null, e.reversedBy ?? null]);
}

export async function registerOpening(db: Db, orgId: string, entry: EntryView, actorId: string | null): Promise<void> {
  await db.query(
    `INSERT INTO app.journals (org_id, entry_id, kind, status, entry_date, description, total_minor, created_by, posted_by, posted_at, posting_sequence)
     VALUES ($1, $2, 'opening', 'posted', $3, $4, $5, $6, $6, now(), $7) ON CONFLICT (org_id, entry_id) DO NOTHING`,
    [orgId, entry.entryId, entry.entryDate, entry.description, totals(entry).debits.toString(), actorId, entry.postingSequence ?? null]);
}

// ---------- Workflow ----------

interface Ctx { db: Db; ledger: LedgerGateway }

async function load(ctx: Ctx, scope: OrgScope, entryId: string): Promise<JournalRow> {
  const row = await getJournal(ctx.db, scope.org.id, entryId);
  if (!row) throw new BusinessRuleError('JOURNAL_NOT_FOUND', 'Journal not found.');
  return row;
}

function requireStatus(row: JournalRow, allowed: readonly JournalStatus[], message: string): void {
  if (!allowed.includes(row.status)) throw new BusinessRuleError('JOURNAL_STATUS', message);
}

export async function createJournal(ctx: Ctx, scope: OrgScope, raw: unknown, requestId?: string): Promise<JournalRow> {
  const j = parseJournalInput(raw);
  const entry = await ctx.ledger.draftEntry(scope.actor, {
    entryDate: j.entryDate, description: j.description, lines: j.lines,
    ...(j.externalReference ? { externalReference: j.externalReference } : {}),
  }, requestId);
  await ctx.db.query(
    `INSERT INTO app.journals (org_id, entry_id, kind, status, entry_date, description, total_minor, created_by, updated_by)
     VALUES ($1, $2, 'standard', 'draft', $3, $4, $5, $6, $6) ON CONFLICT (org_id, entry_id) DO NOTHING`,
    [scope.org.id, entry.entryId, entry.entryDate, entry.description, j.totalDebits.toString(), scope.actor.actorId]);
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'journal.create', target: entry.entryId });
  return (await getJournal(ctx.db, scope.org.id, entry.entryId))!;
}

export async function updateJournal(ctx: Ctx, scope: OrgScope, entryId: string, raw: unknown): Promise<JournalRow> {
  const row = await load(ctx, scope, entryId);
  requireStatus(row, EDITABLE, row.status === 'submitted' ? 'This journal is waiting for approval. Ask the reviewer to return it before editing.' : 'Only draft journals can be edited.');
  const j = parseJournalInput(raw);
  await ctx.ledger.updateDraft(scope.actor, {
    entryId, entryDate: j.entryDate, description: j.description, lines: j.lines,
    ...(j.externalReference ? { externalReference: j.externalReference } : {}),
  });
  // An edit after approval needs a fresh approval.
  await transition(ctx.db, scope.org.id, entryId, EDITABLE, {
    status: row.status === 'approved' ? 'draft' : row.status, entry_date: j.entryDate, description: j.description,
    total_minor: j.totalDebits.toString(), updated_by: scope.actor.actorId,
    approved_version: null, ...(row.status === 'approved' ? { reviewed_by: null, reviewed_at: null, review_note: 'Changed after approval; approval cleared.' } : {}),
  });
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'journal.update', target: entryId, detail: { approvalCleared: row.status === 'approved' } });
  return (await getJournal(ctx.db, scope.org.id, entryId))!;
}

function requireBalanced(entry: EntryView): void {
  const { debits, credits } = totals(entry);
  if (entry.lines.length < 2 || debits === 0n) throw new BusinessRuleError('UNBALANCED', 'A journal needs at least two lines with amounts.');
  if (debits !== credits) throw new BusinessRuleError('UNBALANCED', 'Debits and credits must be equal before this step.');
}

export async function submitJournal(ctx: Ctx, scope: OrgScope, entryId: string): Promise<JournalRow> {
  if (!scope.org.journal_approval_required) throw new BusinessRuleError('APPROVAL_OFF', 'Journal approval is switched off for this client; post the journal directly.');
  const row = await load(ctx, scope, entryId);
  requireStatus(row, ['draft', 'returned'], 'Only draft or returned journals can be submitted.');
  requireBalanced(await ctx.ledger.getEntry(scope.actor, entryId));
  await transition(ctx.db, scope.org.id, entryId, ['draft', 'returned'], {
    status: 'submitted', submitted_by: scope.actor.actorId, submitted_at: new Date(), reviewed_by: null, reviewed_at: null, review_note: null,
  });
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'journal.submit', target: entryId });
  return (await getJournal(ctx.db, scope.org.id, entryId))!;
}

export async function approveJournal(ctx: Ctx, scope: OrgScope, entryId: string): Promise<JournalRow> {
  const row = await load(ctx, scope, entryId);
  requireStatus(row, ['submitted'], 'Only submitted journals can be approved.');
  const me = scope.actor.actorId;
  if ([row.created_by, row.updated_by, row.submitted_by].includes(me)) {
    throw new BusinessRuleError('SAME_PERSON', 'You prepared or submitted this journal, so someone else must approve it.');
  }
  const entry = await ctx.ledger.getEntry(scope.actor, entryId);
  requireBalanced(entry);
  await transition(ctx.db, scope.org.id, entryId, ['submitted'], {
    status: 'approved', reviewed_by: me, reviewed_at: new Date(), review_note: null, approved_version: entry.version,
  });
  await audit(ctx.db, { actorId: me, orgId: scope.org.id, action: 'journal.approve', target: entryId });
  return (await getJournal(ctx.db, scope.org.id, entryId))!;
}

export async function returnJournal(ctx: Ctx, scope: OrgScope, entryId: string, reason: string): Promise<JournalRow> {
  const note = reason.trim();
  if (!note || note.length > 500) throw new BusinessRuleError('REASON_REQUIRED', 'Give a reason (up to 500 characters) so the preparer knows what to fix.');
  const row = await load(ctx, scope, entryId);
  requireStatus(row, ['submitted'], 'Only submitted journals can be returned.');
  await transition(ctx.db, scope.org.id, entryId, ['submitted'], {
    status: 'returned', reviewed_by: scope.actor.actorId, reviewed_at: new Date(), review_note: note, approved_version: null,
  });
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'journal.return', target: entryId, detail: { reason: note } });
  return (await getJournal(ctx.db, scope.org.id, entryId))!;
}

export async function postJournal(ctx: Ctx, scope: OrgScope, entryId: string): Promise<JournalRow> {
  const row = await load(ctx, scope, entryId);
  const entry = await ctx.ledger.getEntry(scope.actor, entryId);
  let expectedVersion: number | undefined;
  if (entry.state !== 'posted') {
    if (scope.org.journal_approval_required) {
      requireStatus(row, ['approved'], 'This client requires approval: submit the journal and have a reviewer approve it before posting.');
      expectedVersion = row.approved_version ?? undefined;
      if (expectedVersion == null) throw new BusinessRuleError('JOURNAL_STATUS', 'This approval has no recorded version. Ask the reviewer to approve it again.');
    } else {
      requireStatus(row, ['draft', 'returned', 'approved', 'submitted'], 'Only draft journals can be posted.');
    }
    requireBalanced(entry);
  }
  // A stable request ID per approved version: a double-click or retry posts once and returns the same result.
  const requestId = `post:${scope.actor.ledgerId}:${entryId}${expectedVersion != null ? `:v${expectedVersion}` : ''}`;
  let posted: EntryView;
  try {
    // The runtime posts only the approved version, in its own transaction (Bookkeeping BR-28).
    posted = await ctx.ledger.postEntry(scope.actor, entryId, requestId, expectedVersion);
  } catch (error) {
    if (error instanceof RuntimeError && error.code === 'Conflict' && error.reason === 'ENTRY_VERSION_MISMATCH') {
      await transition(ctx.db, scope.org.id, entryId, ['approved'], { status: 'draft', approved_version: null, review_note: 'Changed after approval; approval cleared.' });
      throw new BusinessRuleError('CHANGED_SINCE_APPROVAL', 'The journal changed after it was approved. It is back in draft and needs approval again.');
    }
    throw error;
  }
  await transition(ctx.db, scope.org.id, entryId, ['draft', 'returned', 'approved', 'submitted', 'posted'], {
    status: 'posted', posted_by: row.posted_by ?? scope.actor.actorId, posted_at: row.posted_at ?? new Date(), posting_sequence: posted.postingSequence ?? null,
  });
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'journal.post', target: entryId, detail: { postingSequence: posted.postingSequence, version: posted.version } });
  return (await getJournal(ctx.db, scope.org.id, entryId))!;
}

export async function discardJournal(ctx: Ctx, scope: OrgScope, entryId: string): Promise<JournalRow> {
  const row = await load(ctx, scope, entryId);
  requireStatus(row, EDITABLE, row.status === 'submitted' ? 'This journal is waiting for approval. Ask the reviewer to return it first.' : 'Only draft journals can be discarded.');
  await ctx.ledger.discardDraft(scope.actor, entryId);
  await transition(ctx.db, scope.org.id, entryId, EDITABLE, { status: 'discarded', updated_by: scope.actor.actorId });
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'journal.discard', target: entryId });
  return (await getJournal(ctx.db, scope.org.id, entryId))!;
}

export async function reverseJournal(ctx: Ctx, scope: OrgScope, entryId: string, input: { reversalDate: string; reason: string }): Promise<{ original: JournalRow; reversal: JournalRow }> {
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) throw new BusinessRuleError('REASON_REQUIRED', 'Give a reason for the reversal (up to 500 characters).');
  const row = await load(ctx, scope, entryId);
  requireStatus(row, ['posted'], 'Only posted journals can be reversed.');
  if (row.kind === 'reversal') throw new BusinessRuleError('REVERSAL_NOT_ALLOWED', 'A reversing journal cannot itself be reversed. Post a new journal instead.');
  // Journals posted by a fee note, receipt or credit note are corrected through that document,
  // so the receivables records and the ledger never disagree.
  if (row.source_type) throw new BusinessRuleError('SOURCE_DOCUMENT', 'This journal was posted by a receivables document. Correct it there (for example with a credit note).');
  if (input.reversalDate < row.entry_date) throw new BusinessRuleError('REVERSAL_DATE', 'The reversal date cannot be before the original journal\'s date.');
  const reversal = await ctx.ledger.reverseEntry(scope.actor, { entryId, reversalDate: input.reversalDate, reason }, `reverse:${scope.actor.ledgerId}:${entryId}`);
  await ctx.db.query(
    `INSERT INTO app.journals (org_id, entry_id, kind, status, entry_date, description, total_minor, created_by, updated_by, posted_by, posted_at, posting_sequence, reversal_of, review_note)
     VALUES ($1, $2, 'reversal', 'posted', $3, $4, $5, $6, $6, $6, now(), $7, $8, $9) ON CONFLICT (org_id, entry_id) DO NOTHING`,
    [scope.org.id, reversal.entryId, reversal.entryDate, reversal.description, totals(reversal).debits.toString(), scope.actor.actorId, reversal.postingSequence ?? null, entryId, reason]);
  await transition(ctx.db, scope.org.id, entryId, ['posted'], { status: 'reversed', reversed_by_entry: reversal.entryId });
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'journal.reverse', target: entryId, detail: { reversal: reversal.entryId, reason } });
  return { original: (await getJournal(ctx.db, scope.org.id, entryId))!, reversal: (await getJournal(ctx.db, scope.org.id, reversal.entryId))! };
}

export const newRequestId = () => randomUUID();
