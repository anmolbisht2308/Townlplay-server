import { z } from "zod";
import { objectIdSchema, type BookingPolicy, type PricingRule } from "./listing.js";
import { percentOfPaise } from "./money.js";
import { dateStringSchema, paiseSchema, phoneSchema, timeStringSchema } from "./schemas.js";
import { addDays, istDate, istToUtc, minutesToTime, timeToMinutes, weekday } from "./time.js";

/** Players can book this many days ahead, today included. */
export const BOOKING_WINDOW_DAYS = 14;
/** A hold keeps slots for this long while the player pays. */
export const HOLD_MINUTES = 10;
/** Slots starting sooner than this are shown as past (online booking). */
export const PAST_BUFFER_MINUTES = 15;

/** `batch` = a slot reserved by a coaching batch (memberships). */
export const BOOKING_SOURCES = ["online", "walkin", "phone", "block", "batch"] as const;
export const OWNER_BOOKING_SOURCES = ["walkin", "phone", "block"] as const;
export const BOOKING_STATUSES = [
  "pending_payment",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
  "expired",
] as const;
export const BALANCE_METHODS = ["cash", "upi"] as const;
export const SLOT_STATUSES = ["available", "taken", "past", "unpriced"] as const;

export type BookingSource = (typeof BOOKING_SOURCES)[number];
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export type SlotStatus = (typeof SLOT_STATUSES)[number];

// ---------- slot generation ----------

export interface DayHours {
  open: string;
  close: string;
  closed: boolean;
}

export interface GeneratedSlot {
  startTime: string;
  endTime: string;
  /** null when part of the slot is not covered by any price band (not bookable). */
  pricePaise: number | null;
}

/**
 * Price of one slot. Band prices are per full slot; a slot that crosses a band boundary is
 * charged pro rata by minutes in each band (e.g. 16:30–17:30 across 800/1200 bands → 1000).
 */
export function slotPrice(
  rules: PricingRule[],
  day: number,
  start: number,
  duration: number,
): number | null {
  const bands = rules.filter((r) => r.days.includes(day));
  let covered = 0;
  let weighted = 0;
  for (const band of bands) {
    const from = Math.max(start, timeToMinutes(band.start));
    const to = Math.min(start + duration, timeToMinutes(band.end));
    if (to > from) {
      covered += to - from;
      weighted += (to - from) * band.pricePaise;
    }
  }
  if (covered < duration) return null;
  return Math.round(weighted / duration);
}

/** Every slot of a court on an IST date, from opening time, each ending by closing time. */
export function generateSlots(
  hours: DayHours[],
  slotDurationMins: number,
  rules: PricingRule[],
  date: string,
): GeneratedSlot[] {
  const day = weekday(date);
  const h = hours[day];
  if (!h || h.closed) return [];
  const open = timeToMinutes(h.open);
  const close = timeToMinutes(h.close);
  const slots: GeneratedSlot[] = [];
  for (let start = open; start + slotDurationMins <= close; start += slotDurationMins) {
    slots.push({
      startTime: minutesToTime(start),
      endTime: minutesToTime(start + slotDurationMins),
      pricePaise: slotPrice(rules, day, start, slotDurationMins),
    });
  }
  return slots;
}

/** True when start times are distinct, sorted-able and each follows the previous by one slot. */
export function areConsecutive(startTimes: string[], slotDurationMins: number): boolean {
  const mins = [...startTimes].map(timeToMinutes).sort((a, b) => a - b);
  return mins.every((m, i) => i === 0 || m - mins[i - 1]! === slotDurationMins);
}

/** Dates players may book: today … today + 13 (IST). */
export function bookableDates(now: Date = new Date()): string[] {
  const today = istDate(now);
  return Array.from({ length: BOOKING_WINDOW_DAYS }, (_, i) => addDays(today, i));
}

// ---------- amounts and refunds ----------

export interface BookingAmount {
  totalPaise: number;
  advancePaise: number;
  balancePaise: number;
  convenienceFeePaise: number;
}

export interface ConvenienceFee {
  flatPaise: number;
  percent: number;
}

/**
 * Convenience fee charged to the player on top of the online advance: flat + percent of the
 * advance. Nothing is charged when nothing is paid online.
 */
export function convenienceFeePaise(advancePaise: number, fee: ConvenienceFee): number {
  if (advancePaise <= 0) return 0;
  return fee.flatPaise + percentOfPaise(advancePaise, fee.percent);
}

export function bookingAmount(
  slotPrices: number[],
  advancePercent: number,
  fee: ConvenienceFee = { flatPaise: 0, percent: 0 },
): BookingAmount {
  const totalPaise = slotPrices.reduce((a, b) => a + b, 0);
  const advancePaise = percentOfPaise(totalPaise, advancePercent);
  return {
    totalPaise,
    advancePaise,
    balancePaise: totalPaise - advancePaise,
    convenienceFeePaise: convenienceFeePaise(advancePaise, fee),
  };
}

export type CancelledBy = "player" | "owner" | "system";

/** What the player paid online: advance + convenience fee. */
export const paidOnlinePaise = (a: Pick<BookingAmount, "advancePaise" | "convenienceFeePaise">) =>
  a.advancePaise + a.convenienceFeePaise;

/**
 * Refund when a booking is cancelled. Player: `refundPercentBeforeCutoff` of the advance if
 * cancelled at least `cancellationCutoffHours` before the start, else nothing (the convenience
 * fee is kept). Owner or system (e.g. a late payment for a slot already taken): everything paid
 * online, fee included.
 */
export function refundPaise(
  policy: Pick<BookingPolicy, "cancellationCutoffHours" | "refundPercentBeforeCutoff">,
  booking: {
    date: string;
    startTime: string;
    amount: Pick<BookingAmount, "advancePaise" | "convenienceFeePaise">;
  },
  by: CancelledBy,
  now: Date = new Date(),
): number {
  if (by !== "player") return paidOnlinePaise(booking.amount);
  const startsAt = istToUtc(booking.date, booking.startTime).getTime();
  const cutoff = startsAt - policy.cancellationCutoffHours * 3_600_000;
  if (now.getTime() > cutoff) return 0;
  return percentOfPaise(booking.amount.advancePaise, policy.refundPercentBeforeCutoff);
}

// ---------- api schemas ----------

export const availabilityQuerySchema = z.object({ date: dateStringSchema });

export const slotSchema = z.object({
  startTime: timeStringSchema,
  endTime: z.string(),
  pricePaise: paiseSchema.nullable(),
  status: z.enum(SLOT_STATUSES),
});
export type Slot = z.infer<typeof slotSchema>;

export const resourceAvailabilitySchema = z.object({
  resourceId: z.string(),
  name: z.string(),
  sport: z.string(),
  slotDurationMins: z.number().int(),
  slots: z.array(slotSchema),
});
export type ResourceAvailability = z.infer<typeof resourceAvailabilitySchema>;

export const venueAvailabilitySchema = z.object({
  venueId: z.string(),
  date: z.string(),
  resources: z.array(resourceAvailabilitySchema),
});
export type VenueAvailability = z.infer<typeof venueAvailabilitySchema>;

export const customerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  phone: phoneSchema,
});
export type Customer = z.infer<typeof customerSchema>;

const startTimesSchema = z
  .array(timeStringSchema)
  .min(1)
  .max(12)
  .refine((s) => new Set(s).size === s.length, "Slots must not repeat");

export const holdRequestSchema = z
  .object({
    resourceId: objectIdSchema,
    date: dateStringSchema,
    startTimes: startTimesSchema,
    customer: customerSchema,
  })
  .strict();
export type HoldRequest = z.infer<typeof holdRequestSchema>;

export const ownerBookingRequestSchema = z
  .object({
    resourceId: objectIdSchema,
    date: dateStringSchema,
    startTimes: startTimesSchema,
    source: z.enum(OWNER_BOOKING_SOURCES),
    customer: customerSchema.optional(),
    note: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((b) => b.source === "block" || b.customer !== undefined, {
    message: "Walk-in and phone bookings need a customer",
    path: ["customer"],
  });
export type OwnerBookingRequest = z.infer<typeof ownerBookingRequestSchema>;

export const cancelRequestSchema = z
  .object({ reason: z.string().trim().max(300).optional() })
  .strict();
export const balanceRequestSchema = z.object({ method: z.enum(BALANCE_METHODS) }).strict();

export const bookingListQuerySchema = z.object({
  scope: z.enum(["upcoming", "past"]).default("upcoming"),
});
export const calendarQuerySchema = z.object({ date: dateStringSchema });

export const amountSchema = z.object({
  totalPaise: paiseSchema,
  advancePaise: paiseSchema,
  balancePaise: paiseSchema,
  convenienceFeePaise: paiseSchema,
});

export const bookingSchema = z.object({
  id: z.string(),
  code: z.string(),
  venue: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    citySlug: z.string(),
    area: z.string(),
    contactPhone: z.string(),
    location: z.object({ lat: z.number(), lng: z.number() }),
  }),
  resource: z.object({ id: z.string(), name: z.string(), sport: z.string() }),
  customer: customerSchema.nullable(),
  date: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  slots: z.array(z.string()),
  source: z.enum(BOOKING_SOURCES),
  status: z.enum(BOOKING_STATUSES),
  amount: amountSchema,
  balanceCollected: z.object({
    method: z.enum(BALANCE_METHODS).nullable(),
    at: z.string().nullable(),
  }),
  holdExpiresAt: z.string().nullable(),
  cancellation: z
    .object({
      by: z.enum(["player", "owner", "system"]),
      reason: z.string().nullable(),
      refundPaise: paiseSchema,
      refundStatus: z.enum(["none", "pending", "processed", "failed"]),
      at: z.string(),
    })
    .nullable(),
  note: z.string().nullable(),
  /** Paid online by open-game joiners / split-payment friends, towards the venue balance. */
  sharesPaidPaise: paiseSchema,
  /** Balance still to collect at the venue: balance − shares paid online. */
  balanceDuePaise: paiseSchema,
  openGameId: z.string().nullable(),
  split: z.boolean(),
  /** Taken off the slot prices by the player's membership plan. */
  memberDiscountPaise: paiseSchema,
  /** Refund the player would get if they cancelled now (player view of an active booking). */
  refundIfCancelledNowPaise: paiseSchema.nullable(),
  createdAt: z.string(),
});
export type Booking = z.infer<typeof bookingSchema>;

export const calendarSchema = z.object({
  venueId: z.string(),
  date: z.string(),
  resources: z.array(resourceAvailabilitySchema),
  bookings: z.array(bookingSchema),
});
export type Calendar = z.infer<typeof calendarSchema>;

/** Socket.io event pushed to `venue:<id>` rooms when a booking changes. */
export const bookingEventSchema = z.object({
  type: z.enum(["created", "updated", "cancelled"]),
  venueId: z.string(),
  date: z.string(),
  bookingId: z.string(),
});
export type BookingEvent = z.infer<typeof bookingEventSchema>;
export const BOOKING_EVENT = "booking";
export const SOCKET_PATH = "/v1/socket.io";
