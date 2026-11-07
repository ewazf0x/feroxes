/**
 * Money is an integer number of nano-dollars (1e-9 USD) in code, and numeric(18,9) in Postgres.
 * Integers make budget sums exact; nano precision keeps tiny embedding calls from rounding to zero.
 * Number.MAX_SAFE_INTEGER nano-dollars is about $9 million, far beyond any personal budget.
 */
export type NanoUsd = number;

export const NANOS_PER_USD = 1_000_000_000;

export function usd(amount: number): NanoUsd {
  return Math.round(amount * NANOS_PER_USD);
}

export function toUsd(nanos: NanoUsd): number {
  return nanos / NANOS_PER_USD;
}

/** Cost of `tokens` at `usdPerMillion`, rounded to the nearest nano-dollar. */
export function costPerMillion(tokens: number, usdPerMillion: number): NanoUsd {
  // usdPerMillion / 1e6 USD per token = usdPerMillion * 1e3 nano-USD per token
  return Math.round(tokens * usdPerMillion * 1_000);
}

export function formatUsd(nanos: NanoUsd, digits?: number): string {
  const value = toUsd(nanos);
  const d = digits ?? (Math.abs(value) >= 1 ? 2 : Math.abs(value) >= 0.01 ? 4 : 6);
  return `$${value.toFixed(d)}`;
}
