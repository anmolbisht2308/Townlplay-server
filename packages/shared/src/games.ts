import { z } from "zod";
import { SPORTS } from "./constants.js";
import { objectIdSchema } from "./listing.js";
import { paiseSchema, phoneSchema } from "./schemas.js";

export const SKILL_LEVELS = ["beginner", "intermediate", "advanced", "any"] as const;
export const GAME_STATUSES = ["open", "full", "closed", "cancelled", "completed"] as const;
export const SHARE_STATUSES = [
  "pending",
  "held",
  "paid",
  "expired",
  "refunded",
  "cancelled",
] as const;
/** Joining closes this long before the game starts; then the host keeps or cancels it. */
export const GAME_JOIN_CUTOFF_MINUTES = 120;

export type SkillLevel = (typeof SKILL_LEVELS)[number];
export type GameStatus = (typeof GAME_STATUSES)[number];
export type ShareStatus = (typeof SHARE_STATUSES)[number];

// ---------- open games ----------

export const openGameRequestSchema = z
  .object({
    skillLevel: z.enum(SKILL_LEVELS),
    spotsNeeded: z.number().int().min(1).max(30),
    /** 0 = free to join. Joiners' payments go towards the booking's venue balance. */
    pricePerHeadPaise: paiseSchema.max(500_000),
    note: z.string().trim().max(300).optional(),
  })
  .strict();
export type OpenGameRequest = z.infer<typeof openGameRequestSchema>;

export const joinGameRequestSchema = z
  .object({ name: z.string().trim().min(2).max(80), phone: phoneSchema })
  .strict();

export const gameCardSchema = z.object({
  id: z.string(),
  sport: z.enum(SPORTS),
  skillLevel: z.enum(SKILL_LEVELS),
  venueName: z.string(),
  area: z.string(),
  date: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  spotsLeft: z.number().int(),
  totalSpots: z.number().int(),
  pricePerHeadPaise: paiseSchema,
  hostFirstName: z.string(),
  status: z.enum(GAME_STATUSES),
});
export type GameCard = z.infer<typeof gameCardSchema>;

export const gameSchema = gameCardSchema.extend({
  bookingId: z.string(),
  citySlug: z.string(),
  venueSlug: z.string(),
  courtName: z.string(),
  location: z.object({ lat: z.number(), lng: z.number() }),
  note: z.string().nullable(),
  joinCutoffAt: z.string(),
  startsAt: z.string(),
  /** Only for the host: the people who joined. */
  players: z
    .array(
      z.object({
        shareId: z.string(),
        name: z.string(),
        phone: z.string(),
        status: z.enum(SHARE_STATUSES),
      }),
    )
    .nullable(),
  /** The viewer's own spot, if they joined. */
  myShare: z
    .object({
      id: z.string(),
      status: z.enum(SHARE_STATUSES),
      holdExpiresAt: z.string().nullable(),
    })
    .nullable(),
  isHost: z.boolean(),
});
export type Game = z.infer<typeof gameSchema>;

export const gameListQuerySchema = z.object({
  day: z.enum(["today", "tomorrow", "all"]).default("all"),
  sport: z.enum(SPORTS).optional(),
});

// ---------- split payments ----------

export const splitRequestSchema = z
  .object({
    shares: z
      .array(
        z
          .object({ name: z.string().trim().min(2).max(80), phone: phoneSchema.optional() })
          .strict(),
      )
      .min(2)
      .max(20),
  })
  .strict();
export type SplitRequest = z.infer<typeof splitRequestSchema>;

/** Splits paise into n integer parts that differ by at most one paisa and sum exactly. */
export function splitPaise(total: number, n: number): number[] {
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isInteger(n) || n < 1)
    throw new RangeError("bad split");
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

export const shareSchema = z.object({
  id: z.string(),
  kind: z.enum(["game", "split"]),
  name: z.string(),
  amountPaise: paiseSchema,
  feePaise: paiseSchema,
  status: z.enum(SHARE_STATUSES),
  /** Split shares: the pay link token (organiser view only). */
  token: z.string().nullable(),
  paidAt: z.string().nullable(),
});
export type Share = z.infer<typeof shareSchema>;

/** What a friend sees when opening a split-payment link. */
export const sharePageSchema = z.object({
  id: z.string(),
  name: z.string(),
  amountPaise: paiseSchema,
  feePaise: paiseSchema,
  status: z.enum(SHARE_STATUSES),
  organiserFirstName: z.string(),
  venueName: z.string(),
  courtName: z.string(),
  date: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  deadline: z.string(),
});
export type SharePage = z.infer<typeof sharePageSchema>;

export const bookingSharesSchema = z.object({
  bookingId: z.string(),
  balancePaise: paiseSchema,
  sharesPaidPaise: paiseSchema,
  /** What the organiser still pays at the venue. */
  balanceDuePaise: paiseSchema,
  shares: z.array(shareSchema),
  openGameId: z.string().nullable(),
});
export type BookingShares = z.infer<typeof bookingSharesSchema>;

export const shareTokenParamsSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});
export const shareIdSchema = objectIdSchema;
