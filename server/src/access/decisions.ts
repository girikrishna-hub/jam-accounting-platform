import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthorizationDecision, AuthorizationRequest, AuthorizationVerdict } from '@governedai-labs/bookkeeping-runtime';

/**
 * Authorization decisions for the ledger runtime.
 *
 * The app's access adapter checks role, org assignment and object state, then issues a
 * short-lived decision for exactly one operation, ledger and actor. The runtime verifies it
 * through `verifyDecision` (wired into VerifierAuthorization). Evidence is an HMAC over the
 * decision fields, so only this server can mint decisions and none can be altered.
 */

export const DECISION_TTL_MS = 60_000;

function canonical(d: Omit<AuthorizationDecision, 'evidence'>): string {
  return JSON.stringify([d.decisionId, d.actorId, d.operation, d.ledgerId ?? null, d.issuedAt, d.expiresAt]);
}

function sign(key: string, d: Omit<AuthorizationDecision, 'evidence'>): string {
  return createHmac('sha256', key).update(canonical(d)).digest('base64url');
}

export function issueDecision(
  key: string,
  input: { actorId: string; operation: string; ledgerId: string | null; now?: Date; ttlMs?: number },
): AuthorizationDecision {
  const now = input.now ?? new Date();
  // Back-date issuedAt by one second so a decision is valid on the runtime's clock at once.
  const base = {
    decisionId: randomUUID(),
    actorId: input.actorId,
    operation: input.operation,
    ledgerId: input.ledgerId,
    issuedAt: new Date(now.getTime() - 1000).toISOString(),
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? DECISION_TTL_MS)).toISOString(),
  };
  return { ...base, evidence: sign(key, base) };
}

export function makeDecisionVerifier(key: string) {
  return async (decision: AuthorizationDecision, request: AuthorizationRequest): Promise<AuthorizationVerdict> => {
    const { evidence, ...rest } = decision;
    if (typeof evidence !== 'string' || !evidence) return { allowed: false, reason: 'EVIDENCE_MISSING' };
    const expected = Buffer.from(sign(key, rest));
    const actual = Buffer.from(evidence);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { allowed: false, reason: 'EVIDENCE_INVALID' };
    if (decision.operation !== request.operation) return { allowed: false, reason: 'OPERATION_MISMATCH' };
    if (decision.actorId !== request.actorId) return { allowed: false, reason: 'ACTOR_MISMATCH' };
    // Root-creating commands (CreateLedger) carry no ledger; every other decision names exactly one.
    if ((decision.ledgerId ?? null) !== (request.scope ?? null)) return { allowed: false, reason: 'SCOPE_MISMATCH' };
    const now = Date.parse(request.now);
    if (!(Date.parse(decision.issuedAt) <= now && now < Date.parse(decision.expiresAt))) return { allowed: false, reason: 'EXPIRED' };
    return { allowed: true };
  };
}
