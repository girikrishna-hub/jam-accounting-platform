import type { ErrorRequestHandler } from 'express';
import { RuntimeError } from '@governedai-labs/bookkeeping-runtime';
import { ZodError } from 'zod';
import { AccessDenied } from '../access/policy.ts';
import { BusinessRuleError } from '../services/books.ts';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export const notFound = () => new HttpError(404, 'NOT_FOUND', 'Not found.');

const RUNTIME_MESSAGES: Partial<Record<string, string>> = {
  DuplicateAccountCode: 'An account with this code already exists.',
  OpeningBalancesExist: 'Opening balances have already been posted for this client.',
  PeriodOverlap: 'That period overlaps an existing period.',
  NoOpenPeriod: 'There is no open period for that date.',
  PeriodClosed: 'That period is closed.',
  UnbalancedEntry: 'Debits and credits do not agree.',
  AccountInactive: 'The account is inactive.',
  NormalBalanceLocked: 'The normal balance cannot change once the account has postings.',
  LedgerSuspended: 'This client\'s books are suspended.',
  LedgerArchived: 'This client\'s books are archived.',
};

/** Maps domain and runtime errors to HTTP. Internal details never reach the client. */
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.code, message: error.message, details: error.details });
  } else if (error instanceof AccessDenied) {
    res.status(403).json({ error: 'FORBIDDEN', message: 'You do not have permission for this action.' });
  } else if (error instanceof ZodError) {
    res.status(400).json({ error: 'INVALID_INPUT', message: 'The request is not valid.', details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  } else if (error instanceof BusinessRuleError) {
    res.status(422).json({ error: error.code, message: error.message, details: error.details });
  } else if (error instanceof RuntimeError) {
    const code = error.code as string;
    if (code === 'NotAuthorized') res.status(403).json({ error: 'FORBIDDEN', message: 'You do not have permission for this action.' });
    else if (code.endsWith('NotFound')) res.status(404).json({ error: 'NOT_FOUND', message: 'Not found.' });
    else if (code === 'Conflict') res.status(409).json({ error: 'CONFLICT', message: 'Someone else changed this at the same time. Try again.' });
    else res.status(422).json({ error: code, message: RUNTIME_MESSAGES[code] ?? 'The ledger rejected this change.' });
  } else if (error && typeof error === 'object' && 'type' in error && (error as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'TOO_LARGE', message: 'The file is too large.' });
  } else if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({ error: 'INVALID_JSON', message: 'The request body is not valid JSON.' });
  } else {
    console.error(error);
    res.status(500).json({ error: 'INTERNAL', message: 'Something went wrong.' });
  }
};
