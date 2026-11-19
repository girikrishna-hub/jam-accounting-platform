/**
 * Money as integer minor units (constitution: no floating point).
 * The ledger exchanges amounts as decimal strings of minor units ("10000" = 100.00).
 */

const AMOUNT = /^(-)?(\d{1,15})(?:\.(\d{1,4}))?$/;

/**
 * Parses a human amount such as "1,234.56", "(1,234.56)", "-1234.5" or "J$8,075" into minor units.
 * Returns null when the text is not a plain amount or has more decimals than the currency allows.
 */
export function parseAmount(text: string, decimalPlaces = 2): bigint | null {
  let s = text.trim().replace(/^J\$|^\$|^JMD\s*/i, '').replace(/,/g, '').replace(/\s+/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  const m = AMOUNT.exec(s);
  if (!m) return null;
  const fraction = m[3] ?? '';
  if (fraction.length > decimalPlaces) return null;
  const minor = BigInt(m[2]! + fraction.padEnd(decimalPlaces, '0'));
  return negative !== Boolean(m[1]) ? -minor : minor;
}

/** Formats minor units for display: 845231055n → "8,452,310.55". */
export function formatMinor(minor: bigint | string, decimalPlaces = 2): string {
  const value = typeof minor === 'string' ? BigInt(minor) : minor;
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimalPlaces + 1, '0');
  const whole = digits.slice(0, digits.length - decimalPlaces).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = decimalPlaces ? '.' + digits.slice(-decimalPlaces) : '';
  return (negative ? '-' : '') + whole + fraction;
}
