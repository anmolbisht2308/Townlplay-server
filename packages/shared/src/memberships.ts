import { z } from "zod";
import { BOOKING_WINDOW_DAYS, customerSchema } from "./booking.js";
import { eventCardSchema } from "./events.js";
import { objectIdSchema } from "./listing.js";
import { percentOfPaise } from "./money.js";
import { dateStringSchema, paiseSchema, timeStringSchema } from "./schemas.js";
import { addDays, addMonths, timeToMinutes, weekday } from "./time.js";

export const PLAN_DURATIONS = [1, 3, 6, 12] as const;
export const MEMBERSHIP_KINDS = ["plan", "batch"] as const;
export const MEMBERSHIP_STATUSES = ["pending_payment", "active", "expired", "cancelled"] as const;
export const BATCH_STATUSES = ["active", "ended"] as const;
/** An unpaid membership keeps its batch seat for this long. */
export const MEMBERSHIP_HOLD_MINUTES = 15;
/**
 * Batch slots are locked this many days ahead (a daily job tops it up). It is longer than the
 * online booking window, so a batch always holds its slots before players can see them.
 */
export const BATCH_LOCK_DAYS = BOOKING_WINDOW_DAYS + 14;
/** Expiry reminders go out this many days before a membership ends. */
export const RENEWAL_REMINDER_DAYS = 3;

export type MembershipKind = (typeof MEMBERSHIP_KINDS)[number];
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];
export type BatchStatus = (typeof BATCH_STATUSES)[number];

const durationSchema = z
  .number()
  .int()
  .refine((n) => (PLAN_DURATIONS as readonly number[]).includes(n), "Pick 1, 3, 6 or 12 months");

// ---------- membership plans ----------

/** Saved whole (PUT) like courts. */
export const planInputSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(1000),
    durationMonths: durationSchema,
    pricePaise: paiseSchema.min(100).max(10_000_000),
    /** Off online bookings at this venue while the membership is active. */
    discountPercent: z.number().int().min(0).max(50),
    /** How many discounted bookings per calendar month; null = every booking. */
    bookingsPerMonth: z.number().int().min(1).max(60).nullable(),
    isActive: z.boolean(),
  })
  .strict();
export type PlanInput = z.infer<typeof planInputSchema>;

export const planSchema = z.object({
  id: z.string(),
  venueId: z.string(),
  name: z.string(),
  description: z.string(),
  durationMonths: z.number().int(),
  pricePaise: paiseSchema,
  discountPercent: z.number().int(),
  bookingsPerMonth: z.number().int().nullable(),
  isActive: z.boolean(),
});
export type Plan = z.infer<typeof planSchema>;

// ---------- coaching batches ----------

const daysSchema = z
  .array(z.number().int().min(0).max(6))
  .min(1)
  .max(7)
  .refine((d) => new Set(d).size === d.length, "Each day once");

const batchCommon = {
  title: z.string().trim().min(2).max(80),
  activity: z.string().trim().min(2).max(60),
  coachName: z.string().trim().min(2).max(80),
  description: z.string().trim().max(1000),
  capacity: z.number().int().min(1).max(200),
  monthlyFeePaise: paiseSchema.min(100).max(10_000_000),
};

export const createBatchSchema = z
  .object({
    ...batchCommon,
    /** Court whose slots the batch reserves; null for activities without a court (pottery). */
    resourceId: objectIdSchema.nullable(),
    days: daysSchema,
    startTime: timeStringSchema,
    endTime: z.union([timeStringSchema, z.literal("24:00")]),
    startDate: dateStringSchema,
  })
  .strict()
  .refine((b) => timeToMinutes(b.endTime) > timeToMinutes(b.startTime), {
    message: "End time must be after the start time",
    path: ["endTime"],
  });
export type CreateBatch = z.infer<typeof createBatchSchema>;

/** The schedule is fixed once created: end the batch and start a new one to change it. */
export const updateBatchSchema = z.object(batchCommon).strict();
export type UpdateBatch = z.infer<typeof updateBatchSchema>;

export const batchSchema = z.object({
  id: z.string(),
  venueId: z.string(),
  title: z.string(),
  activity: z.string(),
  coachName: z.string(),
  description: z.string(),
  resourceId: z.string().nullable(),
  resourceName: z.string().nullable(),
  days: z.array(z.number().int()),
  startTime: z.string(),
  endTime: z.string(),
  capacity: z.number().int(),
  seatsLeft: z.number().int(),
  monthlyFeePaise: paiseSchema,
  startDate: z.string(),
  endDate: z.string().nullable(),
  status: z.enum(BATCH_STATUSES),
});
export type Batch = z.infer<typeof batchSchema>;

/** Dates in [from, to] on the batch's weekdays, never before its start or after its end. */
export function batchDates(
  b: { days: readonly number[]; startDate: string; endDate?: string | null },
  from: string,
  to: string,
): string[] {
  const out: string[] = [];
  let d = from < b.startDate ? b.startDate : from;
  const last = b.endDate && b.endDate < to ? b.endDate : to;
  while (d <= last) {
    if (b.days.includes(weekday(d))) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

// ---------- venue offerings (public) ----------

export const venueOfferingsSchema = z.object({
  plans: z.array(planSchema),
  batches: z.array(batchSchema),
  /** Upcoming club sessions (events of type club_session) at this venue. */
  sessions: z.array(eventCardSchema),
});
export type VenueOfferings = z.infer<typeof venueOfferingsSchema>;

// ---------- memberships ----------

export const joinMembershipRequestSchema = z
  .object({
    planId: objectIdSchema.optional(),
    batchId: objectIdSchema.optional(),
    member: customerSchema,
  })
  .strict()
  .refine((r) => Boolean(r.planId) !== Boolean(r.batchId), "Give exactly one of planId, batchId");
export type JoinMembershipRequest = z.infer<typeof joinMembershipRequestSchema>;

/** A membership runs from `startsOn` for `months` months, both ends inclusive (IST dates). */
export function membershipPeriod(startsOn: string, months: number) {
  return { startsOn, endsOn: addDays(addMonths(startsOn, months), -1) };
}

/** Member price of a slot: the plan's discount off, rounded to the paisa. */
export const memberPricePaise = (pricePaise: number, discountPercent: number) =>
  pricePaise - percentOfPaise(pricePaise, discountPercent);

export const membershipSchema = z.object({
  id: z.string(),
  kind: z.enum(MEMBERSHIP_KINDS),
  plan: z
    .object({
      id: z.string(),
      name: z.string(),
      durationMonths: z.number().int(),
      discountPercent: z.number().int(),
      bookingsPerMonth: z.number().int().nullable(),
    })
    .nullable(),
  batch: z
    .object({
      id: z.string(),
      title: z.string(),
      coachName: z.string(),
      days: z.array(z.number().int()),
      startTime: z.string(),
      endTime: z.string(),
    })
    .nullable(),
  venue: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    citySlug: z.string(),
    contactPhone: z.string(),
  }),
  member: customerSchema,
  startsOn: z.string(),
  endsOn: z.string(),
  pricePaise: paiseSchema,
  convenienceFeePaise: paiseSchema,
  status: z.enum(MEMBERSHIP_STATUSES),
  holdExpiresAt: z.string().nullable(),
  renewalOf: z.string().nullable(),
  /** Id of the paid or pending renewal that follows this one. */
  renewedBy: z.string().nullable(),
  /** Active, not yet renewed: can be renewed now. */
  renewable: z.boolean(),
  /** Days until it ends (active ones). */
  daysLeft: z.number().int().nullable(),
  /** Plans with a monthly cap: discounted bookings used this month. */
  bookingsUsedThisMonth: z.number().int().nullable(),
  createdAt: z.string(),
});
export type Membership = z.infer<typeof membershipSchema>;

// ---------- owner: members and attendance ----------

export const memberListQuerySchema = z.object({
  status: z.enum(["current", "expired", "all"]).default("current"),
  batchId: objectIdSchema.optional(),
});

export const memberRowSchema = z.object({
  id: z.string(),
  kind: z.enum(MEMBERSHIP_KINDS),
  name: z.string(),
  member: customerSchema,
  startsOn: z.string(),
  endsOn: z.string(),
  status: z.enum(MEMBERSHIP_STATUSES),
  pricePaise: paiseSchema,
  renewed: z.boolean(),
});
export type MemberRow = z.infer<typeof memberRowSchema>;

export const cancelMembershipSchema = z
  .object({ reason: z.string().trim().max(300).optional() })
  .strict();

export const attendanceQuerySchema = z.object({ date: dateStringSchema });
export const attendanceUpdateSchema = z
  .object({ date: dateStringSchema, present: z.array(objectIdSchema).max(200) })
  .strict();

export const attendanceSchema = z.object({
  batchId: z.string(),
  batchTitle: z.string(),
  venueId: z.string(),
  date: z.string(),
  /** Whether the batch meets that day. */
  scheduled: z.boolean(),
  members: z.array(
    z.object({
      membershipId: z.string(),
      name: z.string(),
      phone: z.string(),
      present: z.boolean(),
    }),
  ),
});
export type Attendance = z.infer<typeof attendanceSchema>;
