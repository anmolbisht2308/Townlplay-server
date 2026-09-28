import { z } from "zod";
import { AMENITIES, SPORTS } from "./constants.js";
import { paiseSchema, phoneSchema, timeStringSchema } from "./schemas.js";
import { isTimeString, timeToMinutes } from "./time.js";

export const BUSINESS_TYPES = ["sports", "club", "cafe", "event_organizer"] as const;
export const BUSINESS_STATUSES = ["draft", "pending_review", "active", "suspended"] as const;
export const VENUE_CATEGORIES = ["sports", "club", "cafe"] as const;
export const VENUE_STATUSES = ["draft", "pending_review", "live", "hidden"] as const;
export const SLOT_DURATIONS = [30, 60, 90] as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number];
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];
export type VenueCategory = (typeof VENUE_CATEGORIES)[number];
export type VenueStatus = (typeof VENUE_STATUSES)[number];

export const sportSchema = z.enum(SPORTS);
export const amenitySchema = z.enum(AMENITIES);
export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Expected an id");
export const idParamsSchema = z.object({ id: objectIdSchema });

/** "HH:mm" or "24:00" (end of day) for closing / band end times. */
export const endTimeSchema = z
  .string()
  .refine((v) => v === "24:00" || isTimeString(v), "Expected a time HH:mm or 24:00");

// ---------- businesses ----------

export const kycSchema = z.object({
  legalName: z.string().trim().min(2).max(120),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}\d{4}[A-Z]$/, "Invalid PAN")
    .optional(),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, "Invalid GSTIN")
    .optional(),
});

const businessFields = {
  name: z.string().trim().min(2).max(120),
  type: z.enum(BUSINESS_TYPES),
  contactPhone: phoneSchema,
  email: z.email(),
  kyc: kycSchema,
};
export const createBusinessSchema = z.object(businessFields).strict();
export const updateBusinessSchema = z.object(businessFields).partial().strict();
export type CreateBusiness = z.infer<typeof createBusinessSchema>;
export type UpdateBusiness = z.infer<typeof updateBusinessSchema>;

export const businessSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(BUSINESS_TYPES),
  contactPhone: z.string(),
  email: z.string(),
  kyc: kycSchema.partial().extend({ legalName: z.string() }),
  status: z.enum(BUSINESS_STATUSES),
  reviewNote: z.string().nullable(),
  createdAt: z.string(),
});
export type Business = z.infer<typeof businessSchema>;

// ---------- venues ----------

export const dayHoursSchema = z
  .object({ open: timeStringSchema, close: endTimeSchema, closed: z.boolean() })
  .refine((d) => d.closed || timeToMinutes(d.open) < timeToMinutes(d.close), {
    message: "Opening time must be before closing time",
  });
/** Index = weekday (0 = Sunday … 6 = Saturday). */
export const openingHoursSchema = z.array(dayHoursSchema).length(7);
export type OpeningHours = z.infer<typeof openingHoursSchema>;

export const bookingPolicySchema = z.object({
  advancePercent: z.number().int().min(0).max(100),
  cancellationCutoffHours: z.number().int().min(0).max(168),
  refundPercentBeforeCutoff: z.number().int().min(0).max(100),
});
export type BookingPolicy = z.infer<typeof bookingPolicySchema>;

export const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type LatLng = z.infer<typeof locationSchema>;

export const photoSchema = z.object({
  url: z.url({ protocol: /^https$/ }),
  publicId: z.string().min(1).max(300),
});
export type Photo = z.infer<typeof photoSchema>;

const venueFields = {
  name: z.string().trim().min(2).max(120),
  category: z.enum(VENUE_CATEGORIES),
  sports: z.array(sportSchema).max(SPORTS.length),
  amenities: z.array(amenitySchema).max(AMENITIES.length),
  description: z.string().trim().max(3000),
  address: z.string().trim().min(5).max(300),
  area: z.string().trim().min(2).max(80),
  location: locationSchema,
  photos: z.array(photoSchema).max(12),
  openingHours: openingHoursSchema,
  bookingPolicy: bookingPolicySchema,
};
export const createVenueSchema = z
  .object({ businessId: objectIdSchema, citySlug: z.string().min(2).max(60), ...venueFields })
  .strict();
export const updateVenueSchema = z.object(venueFields).partial().strict();
export type CreateVenue = z.infer<typeof createVenueSchema>;
export type UpdateVenue = z.infer<typeof updateVenueSchema>;

export const venueSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  citySlug: z.string(),
  slug: z.string(),
  ...venueFields,
  name: z.string(),
  description: z.string(),
  address: z.string(),
  area: z.string(),
  status: z.enum(VENUE_STATUSES),
  reviewNote: z.string().nullable(),
  updatedAt: z.string(),
});
export type Venue = z.infer<typeof venueSchema>;

// ---------- resources (courts) ----------

export const pricingRuleSchema = z
  .object({
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start: timeStringSchema,
    end: endTimeSchema,
    pricePaise: paiseSchema.max(10_000_000),
  })
  .refine((r) => timeToMinutes(r.start) < timeToMinutes(r.end), {
    message: "Band start must be before its end",
    path: ["end"],
  })
  .refine((r) => new Set(r.days).size === r.days.length, {
    message: "Days must not repeat",
    path: ["days"],
  });
export type PricingRule = z.infer<typeof pricingRuleSchema>;

/** Rules may not overlap on the same weekday (a slot must have exactly one price). */
export function findPricingOverlap(rules: PricingRule[]): [number, number] | null {
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i]!;
      const b = rules[j]!;
      if (!a.days.some((d) => b.days.includes(d))) continue;
      const overlap =
        timeToMinutes(a.start) < timeToMinutes(b.end) &&
        timeToMinutes(b.start) < timeToMinutes(a.end);
      if (overlap) return [i, j];
    }
  }
  return null;
}

export const pricingRulesSchema = z
  .array(pricingRuleSchema)
  .min(1)
  .max(40)
  .superRefine((rules, ctx) => {
    const clash = findPricingOverlap(rules);
    if (clash) {
      ctx.addIssue({
        code: "custom",
        path: [clash[1]],
        message: `Overlaps pricing rule ${clash[0] + 1} on the same day`,
      });
    }
  });

const resourceFields = {
  name: z.string().trim().min(1).max(60),
  sport: sportSchema,
  slotDurationMins: z.union(SLOT_DURATIONS.map((d) => z.literal(d))),
  maxPlayers: z.number().int().min(1).max(100),
  pricingRules: pricingRulesSchema,
  isActive: z.boolean(),
};
export const createResourceSchema = z.object(resourceFields).strict();
export const updateResourceSchema = z.object(resourceFields).partial().strict();
export type CreateResource = z.infer<typeof createResourceSchema>;
export type UpdateResource = z.infer<typeof updateResourceSchema>;

export const resourceSchema = z.object({ id: z.string(), venueId: z.string(), ...resourceFields });
export type Resource = z.infer<typeof resourceSchema>;

/** Lowest price across a resource's bands, or null without rules. */
export function minPricePaise(rules: Pick<PricingRule, "pricePaise">[]): number | null {
  return rules.length === 0 ? null : Math.min(...rules.map((r) => r.pricePaise));
}

// ---------- public listing ----------

export const cityResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  state: z.string(),
});
export type City = z.infer<typeof cityResponseSchema>;

export const venueListQuerySchema = z.object({
  category: z.enum(VENUE_CATEGORIES).optional(),
  sport: sportSchema.optional(),
  area: z.string().trim().max(80).optional(),
  q: z.string().trim().max(80).optional(),
  /** "lat,lng" — sorts by distance. */
  near: z
    .string()
    .regex(/^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?$/, "Expected lat,lng")
    .optional(),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type VenueListQuery = z.infer<typeof venueListQuerySchema>;

export const venueCardSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  category: z.enum(VENUE_CATEGORIES),
  area: z.string(),
  sports: z.array(sportSchema),
  photo: photoSchema.nullable(),
  minPricePaise: paiseSchema.nullable(),
  distanceKm: z.number().nullable(),
});
export type VenueCard = z.infer<typeof venueCardSchema>;

export const venueListResponseSchema = z.object({
  items: z.array(venueCardSchema),
  nextCursor: z.string().nullable(),
});
export type VenueListResponse = z.infer<typeof venueListResponseSchema>;

export const publicVenueSchema = venueSchema
  .omit({ businessId: true, status: true, reviewNote: true })
  .extend({
    cityName: z.string(),
    contactPhone: z.string(),
    resources: z.array(resourceSchema.omit({ isActive: true })),
  });
export type PublicVenue = z.infer<typeof publicVenueSchema>;

export const sitemapEntrySchema = z.object({
  citySlug: z.string(),
  slug: z.string(),
  updatedAt: z.string(),
});
export type SitemapEntry = z.infer<typeof sitemapEntrySchema>;

// ---------- admin review ----------

export const reviewReasonSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export const reviewQueueQuerySchema = z.object({
  kind: z.enum(["business", "venue"]).default("venue"),
  status: z.string().default("pending_review"),
});

export const reviewQueueItemSchema = z.object({
  kind: z.enum(["business", "venue"]),
  id: z.string(),
  name: z.string(),
  status: z.string(),
  businessName: z.string(),
  citySlug: z.string().nullable(),
  slug: z.string().nullable(),
  reviewNote: z.string().nullable(),
  updatedAt: z.string(),
});
export type ReviewQueueItem = z.infer<typeof reviewQueueItemSchema>;

// ---------- uploads ----------

export const uploadSignRequestSchema = z.object({ purpose: z.enum(["venue_photo"]) }).strict();
export const uploadSignatureSchema = z.object({
  uploadUrl: z.url(),
  apiKey: z.string(),
  timestamp: z.number().int(),
  signature: z.string(),
  folder: z.string(),
});
export type UploadSignature = z.infer<typeof uploadSignatureSchema>;
