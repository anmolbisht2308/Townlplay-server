/**
 * The whole product runs in IST (UTC+05:30, no DST). Slot dates are "YYYY-MM-DD" and times
 * "HH:mm" strings in IST; real timestamps are UTC `Date`s.
 */

export const IST_OFFSET_MINUTES = 330;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60_000;
const DAY_MS = 86_400_000;

export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const pad = (n: number) => String(n).padStart(2, "0");

/** True for a real calendar date in "YYYY-MM-DD" form (rejects 2026-02-30). */
export function isDateString(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return d.toISOString().slice(0, 10) === value;
}

export function isTimeString(value: string): boolean {
  return TIME_RE.test(value);
}

/** The IST calendar date of an instant. */
export function istDate(at: Date = new Date()): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The IST wall-clock time ("HH:mm") of an instant. */
export function istTime(at: Date = new Date()): string {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** The UTC instant of an IST date + time. */
export function istToUtc(date: string, time: string = "00:00"): Date {
  if (!isDateString(date)) throw new RangeError(`invalid date: ${date}`);
  if (!isTimeString(time)) throw new RangeError(`invalid time: ${time}`);
  return new Date(Date.parse(`${date}T${time}:00Z`) - IST_OFFSET_MS);
}

/** Adds whole days to an IST date string. */
export function addDays(date: string, days: number): string {
  if (!isDateString(date)) throw new RangeError(`invalid date: ${date}`);
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Day of week for an IST date: 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  if (!isDateString(date)) throw new RangeError(`invalid date: ${date}`);
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** "HH:mm" → minutes since midnight. "24:00" is accepted as an end-of-day bound. */
export function timeToMinutes(time: string): number {
  if (time === "24:00") return 1440;
  if (!isTimeString(time)) throw new RangeError(`invalid time: ${time}`);
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** Minutes since midnight → "HH:mm" (0..1440; 1440 → "24:00"). */
export function minutesToTime(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
    throw new RangeError(`invalid minutes: ${minutes}`);
  }
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}
