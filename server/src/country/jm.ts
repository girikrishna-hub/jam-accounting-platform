/**
 * Jamaica country pack (design pack G7): GCT tax codes for fee notes.
 * Kept apart from the core so other countries can supply their own pack.
 */

export type TaxCode = 'GCT15' | 'EXEMPT' | 'OUT';

export const TAX_CODES: readonly { code: TaxCode; label: string; ratePercent: number }[] = [
  { code: 'GCT15', label: 'GCT 15%', ratePercent: 15 },
  { code: 'EXEMPT', label: 'Exempt', ratePercent: 0 },
  { code: 'OUT', label: 'Outside scope (disbursement)', ratePercent: 0 },
];

/** Default code by line kind: professional fees carry GCT; disbursements are recharged at cost. */
export const DEFAULT_TAX_CODE = { fee: 'GCT15', disbursement: 'OUT' } as const satisfies Record<string, TaxCode>;

const rate = (code: TaxCode) => BigInt(TAX_CODES.find((t) => t.code === code)!.ratePercent);

/**
 * GCT on the document's taxable total for each code, rounded half up to the cent
 * (1,173,913.04 at 15% → 176,086.96).
 */
export function gctFor(lines: readonly { amountMinor: bigint; taxCode: TaxCode }[]): bigint {
  const byCode = new Map<TaxCode, bigint>();
  for (const l of lines) byCode.set(l.taxCode, (byCode.get(l.taxCode) ?? 0n) + l.amountMinor);
  let gct = 0n;
  for (const [code, base] of byCode) gct += roundHalfUp(base * rate(code), 100n);
  return gct;
}

/** GCT on a credited fee amount at the standard rate. */
export function gctOnFees(feesMinor: bigint): bigint {
  return roundHalfUp(feesMinor * rate('GCT15'), 100n);
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const q = (n * 2n + denominator) / (denominator * 2n);
  return negative ? -q : q;
}
