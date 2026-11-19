import { randomBytes } from 'node:crypto';
import {
  DEFAULT_PASSWORD_POLICY,
  PasswordPolicyEvaluator,
  hashCredential,
  verifyCredential,
} from '@governedai-labs/auth-runtime';

/**
 * Passwords through the certified Authentication Runtime: salted scrypt hashing,
 * constant-time verification and the password complexity policy. This app requires
 * 12 characters (stricter than the runtime default of 8) with upper case, lower case and a digit.
 */
export const MIN_PASSWORD_LENGTH = 12;

const policy = new PasswordPolicyEvaluator({ ...DEFAULT_PASSWORD_POLICY, minLength: MIN_PASSWORD_LENGTH });

export class PasswordRejected extends Error {
  constructor(readonly reason: string) {
    super(`Password does not meet the policy: ${reason}`);
    this.name = 'PasswordRejected';
  }
}

/** Plain-language rule for forms and error messages. */
export const PASSWORD_RULE = `At least ${MIN_PASSWORD_LENGTH} characters, with an upper-case letter, a lower-case letter and a digit.`;

export function checkPassword(password: string): { ok: true } | { ok: false; reason: string } {
  const decision = policy.evaluateComplexity(password);
  return decision.accepted ? { ok: true } : { ok: false, reason: decision.reason };
}

export function hashPassword(password: string): string {
  const check = checkPassword(password);
  if (!check.ok) throw new PasswordRejected(check.reason);
  return hashCredential(password);
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    return verifyCredential(password, stored);
  } catch {
    return false;
  }
}

/** A real hash of a random value, verified against unknown emails so sign-in timing does not reveal them. */
export const DUMMY_HASH = hashCredential(randomBytes(24).toString('base64url'));
