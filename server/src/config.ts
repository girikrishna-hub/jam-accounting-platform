import { randomBytes } from 'node:crypto';

export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
  /** HMAC key that signs authorization decisions for the ledger runtime. */
  readonly decisionSigningKey: string;
  /** The operating firm. One firm per deployment in release 1. */
  readonly firmId: string;
  readonly sessionTtlMs: number;
  readonly secureCookies: boolean;
  readonly production: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const production = env.NODE_ENV === 'production' || env.REPLIT_DEPLOYMENT === '1';
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set.');
  let decisionSigningKey = env.DECISION_SIGNING_KEY ?? '';
  if (decisionSigningKey.length < 32) {
    if (production) throw new Error('DECISION_SIGNING_KEY must be set (at least 32 characters) in production.');
    decisionSigningKey = randomBytes(32).toString('hex');
    console.warn('DECISION_SIGNING_KEY not set: using a random key for this process (development only).');
  }
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl,
    decisionSigningKey,
    firmId: env.FIRM_ID ?? 'firm',
    sessionTtlMs: 12 * 60 * 60 * 1000,
    secureCookies: production,
    production,
  };
}
