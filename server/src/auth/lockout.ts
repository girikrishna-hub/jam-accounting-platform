import { DEFAULT_LOCKOUT_POLICY, LockoutPolicyEvaluator } from '@governedai-labs/auth-runtime';
import type { Db } from '../db/db.ts';

/**
 * Sign-in lockout decided by the Authentication Runtime's lockout policy
 * (default: 5 failures within 15 minutes locks the account for 15 minutes).
 * The app stores the failure history; the runtime decides.
 */
const policy = new LockoutPolicyEvaluator(DEFAULT_LOCKOUT_POLICY);

export async function lockedUntil(db: Db, identityKey: string, now = new Date()): Promise<Date | null> {
  const r = await db.query<{ locked_until: Date | null }>('SELECT locked_until FROM app.sign_in_lockout WHERE identity_key = $1', [identityKey]);
  const until = r.rows[0]?.locked_until ?? null;
  return until && until > now ? until : null;
}

/** Records a failure; returns the lock expiry when this failure triggers a lock. */
export async function recordFailure(db: Db, identityKey: string, now = new Date()): Promise<Date | null> {
  const windowStart = new Date(now.getTime() - policy.policy.rollingWindowSeconds * 1000);
  const r = await db.query<{ failures: Date[] }>(
    `INSERT INTO app.sign_in_lockout (identity_key, failures, updated_at) VALUES ($1, ARRAY[$2::timestamptz], $2)
     ON CONFLICT (identity_key) DO UPDATE SET
       failures = (SELECT coalesce(array_agg(f), '{}') FROM unnest(app.sign_in_lockout.failures) f WHERE f >= $3) || $2::timestamptz,
       updated_at = $2
     RETURNING failures`,
    [identityKey, now, windowStart]);
  const count = r.rows[0]?.failures.length ?? 1;
  if (policy.evaluate(count) !== 'Lock') return null;
  const until = policy.lockedUntilFrom(now);
  await db.query(`UPDATE app.sign_in_lockout SET locked_until = $2, failures = '{}' WHERE identity_key = $1`, [identityKey, until]);
  return until;
}

export async function clearFailures(db: Db, identityKey: string): Promise<void> {
  await db.query('DELETE FROM app.sign_in_lockout WHERE identity_key = $1', [identityKey]);
}
