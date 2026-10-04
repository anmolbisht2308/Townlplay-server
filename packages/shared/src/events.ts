import { z } from "zod";
import { locationSchema, objectIdSchema, photoSchema } from "./listing.js";
import { paiseSchema, phoneSchema } from "./schemas.js";
import { addDays, istDate, istToUtc, weekday } from "./time.js";

export const EVENT_TYPES = ["seasonal", "cafe", "club_session"] as const;
export const EVENT_STATUSES = [
  "draft",
  "pending_review",
  "published",
  "cancelled",
  "completed",
] as const;
export const TICKET_ORDER_STATUSES = [
  "pending_payment",
  "paid",
  "cancelled",
  "expired",
  "refunded",
] as const;
export const MAX_TICKETS_PER_ORDER = 10;

export type EventType = (typeof EVENT_TYPES)[number];
export type EventStatus = (typeof EVENT_STATUSES)[number];
export type TicketOrderStatus = (typeof TICKET_ORDER_STATUSES)[number];

const isoDate = z.iso.datetime({ offset: true });

export const tierInputSchema = z
  .object({
    /** Present when editing an existing tier. */
    id: objectIdSchema.optional(),
    name: z.string().trim().min(1).max(60),
    pricePaise: paiseSchema.max(10_000_000),
    capacity: z.number().int().min(1).max(100_000),
  })
  .strict();
export type TierInput = z.infer<typeof tierInputSchema>;

const eventFields = {
  title: z.string().trim().min(3).max(120),
  type: z.enum(EVENT_TYPES),
  description: z.string().trim().max(5000),
  photos: z.array(photoSchema).max(12),
  startsAt: isoDate,
  endsAt: isoDate,
  /** Hosted at one of the business's venues, or at a custom address. */
  venueId: objectIdSchema.nullable(),
  address: z.string().trim().max(300).nullable(),
  location: locationSchema.nullable(),
  ageLimit: z.number().int().min(0).max(25).nullable(),
  tiers: z.array(tierInputSchema).min(1).max(10),
};

function placeAndTime(
  e: {
    startsAt?: string;
    endsAt?: string;
    venueId?: string | null;
    address?: string | null;
    location?: unknown;
  },
  ctx: z.RefinementCtx,
  partial: boolean,
) {
  if (e.startsAt && e.endsAt && Date.parse(e.endsAt) <= Date.parse(e.startsAt)) {
    ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End must be after start" });
  }
  if (!partial && !e.venueId && (!e.address || !e.location)) {
    ctx.addIssue({
      code: "custom",
      path: ["address"],
      message: "Pick a venue or enter an address and map pin",
    });
  }
}

export const createEventSchema = z
  .object({ businessId: objectIdSchema, citySlug: z.string().min(2).max(60), ...eventFields })
  .strict()
  .superRefine((e, ctx) => placeAndTime(e, ctx, false));
export const updateEventSchema = z
  .object(eventFields)
  .partial()
  .strict()
  .superRefine((e, ctx) => placeAndTime(e, ctx, true));
export type CreateEvent = z.infer<typeof createEventSchema>;
export type UpdateEvent = z.infer<typeof updateEventSchema>;

export const tierSchema = z.object({
  id: z.string(),
  name: z.string(),
  pricePaise: paiseSchema,
  capacity: z.number().int(),
  remaining: z.number().int(),
});
export type Tier = z.infer<typeof tierSchema>;

export const eventSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  citySlug: z.string(),
  slug: z.string(),
  title: z.string(),
  type: z.enum(EVENT_TYPES),
  description: z.string(),
  photos: z.array(photoSchema),
  startsAt: z.string(),
  endsAt: z.string(),
  venueId: z.string().nullable(),
  venueName: z.string().nullable(),
  address: z.string(),
  location: locationSchema,
  ageLimit: z.number().nullable(),
  tiers: z.array(tierSchema),
  status: z.enum(EVENT_STATUSES),
  reviewNote: z.string().nullable(),
  updatedAt: z.string(),
});
export type Event = z.infer<typeof eventSchema>;

export const publicEventSchema = eventSchema
  .omit({ businessId: true, status: true, reviewNote: true })
  .extend({
    cityName: z.string(),
    organiserName: z.string(),
    contactPhone: z.string(),
    cancelled: z.boolean(),
  });
export type PublicEvent = z.infer<typeof publicEventSchema>;

export const eventCardSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  type: z.enum(EVENT_TYPES),
  startsAt: z.string(),
  venueName: z.string().nullable(),
  area: z.string(),
  photo: photoSchema.nullable(),
  minPricePaise: paiseSchema,
  soldOut: z.boolean(),
});
export type EventCard = z.infer<typeof eventCardSchema>;

export const EVENT_WHEN = ["upcoming", "this_week", "this_weekend"] as const;
export const eventListQuerySchema = z.object({
  when: z.enum(EVENT_WHEN).default("upcoming"),
  type: z.enum(EVENT_TYPES).optional(),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type EventListQuery = z.infer<typeof eventListQuerySchema>;
export const eventListResponseSchema = z.object({
  items: z.array(eventCardSchema),
  nextCursor: z.string().nullable(),
});

/**
 * UTC window for a listing filter, from IST calendar days: this week = today … Sunday,
 * this weekend = Saturday 00:00 … Monday 00:00 (today counts if it is already the weekend).
 */
export function eventWindow(
  when: (typeof EVENT_WHEN)[number],
  now: Date = new Date(),
): { from: Date; to: Date | null } {
  const today = istDate(now);
  const dow = weekday(today); // 0 = Sunday
  if (when === "upcoming") return { from: now, to: null };
  if (when === "this_week") {
    const daysToMonday = dow === 0 ? 1 : 8 - dow;
    return { from: now, to: istToUtc(addDays(today, daysToMonday)) };
  }
  const saturday = dow === 0 ? addDays(today, -1) : addDays(today, (6 - dow + 7) % 7);
  const from = istToUtc(saturday);
  return { from: from > now ? from : now, to: istToUtc(addDays(saturday, 2)) };
}

// ---------- ticket orders ----------

export const ticketOrderRequestSchema = z
  .object({
    eventId: objectIdSchema,
    items: z
      .array(
        z
          .object({
            tierId: objectIdSchema,
            qty: z.number().int().min(1).max(MAX_TICKETS_PER_ORDER),
          })
          .strict(),
      )
      .min(1)
      .max(10)
      .refine(
        (items) => new Set(items.map((i) => i.tierId)).size === items.length,
        "Tiers must not repeat",
      )
      .refine(
        (items) => items.reduce((s, i) => s + i.qty, 0) <= MAX_TICKETS_PER_ORDER,
        `At most ${MAX_TICKETS_PER_ORDER} tickets per order`,
      ),
    buyer: z.object({ name: z.string().trim().min(2).max(80), phone: phoneSchema }).strict(),
  })
  .strict();
export type TicketOrderRequest = z.infer<typeof ticketOrderRequestSchema>;

export const ticketSchema = z.object({
  id: z.string(),
  tierId: z.string(),
  tierName: z.string(),
  holderName: z.string(),
  /** Only sent to the ticket's owner. */
  qrToken: z.string().nullable(),
  status: z.enum(["valid", "void"]),
  checkedInAt: z.string().nullable(),
});
export type Ticket = z.infer<typeof ticketSchema>;

export const ticketOrderSchema = z.object({
  id: z.string(),
  code: z.string(),
  event: z.object({
    id: z.string(),
    slug: z.string(),
    citySlug: z.string(),
    title: z.string(),
    startsAt: z.string(),
    endsAt: z.string(),
    address: z.string(),
    location: locationSchema,
  }),
  buyer: z.object({ name: z.string(), phone: z.string() }),
  items: z.array(
    z.object({
      tierId: z.string(),
      tierName: z.string(),
      qty: z.number().int(),
      pricePaise: paiseSchema,
    }),
  ),
  totalPaise: paiseSchema,
  convenienceFeePaise: paiseSchema,
  status: z.enum(TICKET_ORDER_STATUSES),
  holdExpiresAt: z.string().nullable(),
  refundPaise: paiseSchema,
  tickets: z.array(ticketSchema),
  createdAt: z.string(),
});
export type TicketOrder = z.infer<typeof ticketOrderSchema>;

// ---------- organiser ----------

export const checkInRequestSchema = z.object({ qrToken: z.string().min(16).max(64) }).strict();
export const checkInResultSchema = z.object({
  result: z.enum(["ok", "already", "invalid", "wrong_event"]),
  ticket: z
    .object({
      id: z.string(),
      holderName: z.string(),
      tierName: z.string(),
      checkedInAt: z.string().nullable(),
    })
    .nullable(),
});
export type CheckInResult = z.infer<typeof checkInResultSchema>;

export const attendeeSchema = z.object({
  ticketId: z.string(),
  orderCode: z.string(),
  holderName: z.string(),
  buyerName: z.string(),
  buyerPhone: z.string(),
  tierName: z.string(),
  checkedInAt: z.string().nullable(),
});
export type Attendee = z.infer<typeof attendeeSchema>;
export const attendeeQuerySchema = z.object({ q: z.string().trim().max(80).optional() });

export const eventDashboardSchema = z.object({
  eventId: z.string(),
  tiers: z.array(
    z.object({
      tierId: z.string(),
      name: z.string(),
      capacity: z.number().int(),
      sold: z.number().int(),
      held: z.number().int(),
      revenuePaise: paiseSchema,
    }),
  ),
  ticketsSold: z.number().int(),
  revenuePaise: paiseSchema,
  checkedIn: z.number().int(),
});
export type EventDashboard = z.infer<typeof eventDashboardSchema>;

// ---------- calendar file ----------

const icsDate = (iso: string) =>
  new Date(iso)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
const icsText = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/[,;]/g, (c) => `\\${c}`);

/** An .ics (iCalendar) file for "add to calendar". */
export function eventIcs(
  e: {
    id: string;
    title: string;
    startsAt: string;
    endsAt: string;
    address: string;
    url: string;
    description?: string;
  },
  now: Date = new Date(),
): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Townplay//Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${e.id}@townplay`,
    `DTSTAMP:${icsDate(now.toISOString())}`,
    `DTSTART:${icsDate(e.startsAt)}`,
    `DTEND:${icsDate(e.endsAt)}`,
    `SUMMARY:${icsText(e.title)}`,
    `LOCATION:${icsText(e.address)}`,
    `DESCRIPTION:${icsText(`${e.description ? `${e.description}\n\n` : ""}${e.url}`)}`,
    `URL:${e.url}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
