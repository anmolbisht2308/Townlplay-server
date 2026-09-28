/** All money is an integer number of paise. These helpers are the only place rupees appear. */

export function isPaise(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Converts a rupee amount typed by a person (e.g. 1250.5) to paise, rounding to the nearest paisa. */
export function rupeesToPaise(rupees: number): number {
  if (!Number.isFinite(rupees)) throw new RangeError("rupees must be a finite number");
  return Math.round(rupees * 100);
}

/**
 * Formats paise as Indian rupees: 125000 → "₹1,250", 125050 → "₹1,250.50".
 * Whole-rupee amounts drop the decimals.
 */
export function formatPaise(paise: number, locale: string = "en-IN"): string {
  if (!Number.isSafeInteger(paise)) throw new RangeError("paise must be an integer");
  const whole = paise % 100 === 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

/** `percent` of an amount in paise, rounded to the nearest paisa (e.g. an advance). */
export function percentOfPaise(paise: number, percent: number): number {
  return Math.round((paise * percent) / 100);
}
