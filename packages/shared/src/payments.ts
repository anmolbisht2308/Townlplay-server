import { z } from "zod";
import { objectIdSchema } from "./listing.js";
import { dateStringSchema, paiseSchema } from "./schemas.js";

export const PAYMENT_PROVIDERS = ["razorpay", "fake"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];
export const PAYMENT_STATUSES = [
  "created",
  "paid",
  "failed",
  "refunded",
  "partially_refunded",
] as const;
export const PAYOUTS_MODES = ["route", "manual"] as const;
export const PAYOUT_STATUSES = ["not_started", "pending", "active", "failed"] as const;

// ---------- checkout ----------

/** Pay for a held booking, ticket order, share or membership (exactly one). */
export const createOrderRequestSchema = z
  .object({
    bookingId: objectIdSchema.optional(),
    ticketOrderId: objectIdSchema.optional(),
    /** A booking share: an open-game spot or a split-payment share. */
    shareId: objectIdSchema.optional(),
    /** A membership plan or coaching batch purchase / renewal. */
    membershipId: objectIdSchema.optional(),
  })
  .strict()
  .refine(
    (r) => [r.bookingId, r.ticketOrderId, r.shareId, r.membershipId].filter(Boolean).length === 1,
    "Give exactly one of bookingId, ticketOrderId, shareId, membershipId",
  );
export type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>;

/** Outcome of a payment step: what was paid for and its status now. */
export const paymentResultSchema = z.object({
  refType: z.enum(["booking", "ticketOrder", "groupShare", "membership"]),
  refId: z.string(),
  status: z.string(),
});
export type PaymentResult = z.infer<typeof paymentResultSchema>;

/** Everything the browser needs to open Razorpay Checkout (or the fake test-mode payment). */
export const orderResponseSchema = z.object({
  provider: z.enum(PAYMENT_PROVIDERS),
  keyId: z.string(),
  orderId: z.string(),
  amountPaise: paiseSchema,
  currency: z.literal("INR"),
  /** Present when nothing had to be paid online (already confirmed). */
  result: paymentResultSchema.nullable(),
});
export type OrderResponse = z.infer<typeof orderResponseSchema>;

export const verifyPaymentRequestSchema = z
  .object({
    razorpayOrderId: z.string().min(1).max(64),
    razorpayPaymentId: z.string().min(1).max(64),
    razorpaySignature: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type VerifyPaymentRequest = z.infer<typeof verifyPaymentRequestSchema>;

/** Public checkout config: which provider the browser talks to and the current convenience fee. */
export const paymentsConfigSchema = z.object({
  provider: z.enum(PAYMENT_PROVIDERS),
  keyId: z.string(),
  convenienceFee: z.object({ flatPaise: paiseSchema, percent: z.number() }),
});
export type PaymentsConfig = z.infer<typeof paymentsConfigSchema>;

export const fakePayRequestSchema = z
  .object({
    orderId: z.string().min(1).max(64),
    outcome: z.enum(["success", "failure"]).default("success"),
  })
  .strict();

// ---------- admin settings ----------

export const convenienceFeeSchema = z
  .object({
    flatPaise: paiseSchema.max(100_000),
    percent: z.number().min(0).max(20),
  })
  .strict();

export const settingsSchema = z.object({ convenienceFee: convenienceFeeSchema }).strict();
export type Settings = z.infer<typeof settingsSchema>;

/** Parses CONVENIENCE_FEE_CONFIG like "flat:1000", "percent:2" or "flat:500,percent:1.5". */
export function parseConvenienceFeeConfig(
  config: string | undefined,
): z.infer<typeof convenienceFeeSchema> {
  const fee = { flatPaise: 0, percent: 0 };
  for (const part of (config ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [key, raw] = part.split(":");
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`Invalid CONVENIENCE_FEE_CONFIG part: ${part}`);
    if (key === "flat") fee.flatPaise = Math.round(value);
    else if (key === "percent") fee.percent = value;
    else throw new Error(`Invalid CONVENIENCE_FEE_CONFIG key: ${key}`);
  }
  return convenienceFeeSchema.parse(fee);
}

// ---------- payouts ----------

export const payoutSetupRequestSchema = z
  .object({
    accountHolderName: z.string().trim().min(3).max(120),
    accountNumber: z.string().regex(/^\d{9,18}$/, "Expected 9–18 digits"),
    ifsc: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Invalid IFSC"),
  })
  .strict();
export type PayoutSetupRequest = z.infer<typeof payoutSetupRequestSchema>;

export const payoutInfoSchema = z.object({
  mode: z.enum(PAYOUTS_MODES),
  status: z.enum(PAYOUT_STATUSES),
  accountHolderName: z.string().nullable(),
  accountLast4: z.string().nullable(),
  ifsc: z.string().nullable(),
});
export type PayoutInfo = z.infer<typeof payoutInfoSchema>;

export const earningsQuerySchema = z.object({ from: dateStringSchema, to: dateStringSchema });

export const earningsSchema = z.object({
  businessId: z.string(),
  from: z.string(),
  to: z.string(),
  bookings: z.number().int(),
  /** Value of bookings that were played or are still upcoming (not cancelled). */
  bookedValuePaise: paiseSchema,
  /** Advances captured online, net of refunds of the advance. Owed to the venue. */
  advanceOnlinePaise: paiseSchema,
  /** Membership and batch fees paid online (net of refunds), included in advanceOnlinePaise. */
  membershipsOnlinePaise: paiseSchema,
  /** Balances the owner marked as collected at the venue (cash/UPI). */
  balanceCollectedPaise: paiseSchema,
  refundsPaise: paiseSchema,
  /** Convenience fees kept by the platform (not owed to the venue). */
  platformFeesPaise: paiseSchema,
  /** Paid out to the venue (Route transfers or recorded manual payouts). */
  paidOutPaise: paiseSchema,
  /** advanceOnlinePaise − paidOutPaise (never below zero). */
  payoutDuePaise: paiseSchema,
  rows: z.array(
    z.object({
      bookingId: z.string(),
      code: z.string(),
      date: z.string(),
      startTime: z.string(),
      venueName: z.string(),
      status: z.string(),
      source: z.string(),
      totalPaise: paiseSchema,
      advanceOnlinePaise: paiseSchema,
      balanceCollectedPaise: paiseSchema,
      refundPaise: paiseSchema,
    }),
  ),
});
export type Earnings = z.infer<typeof earningsSchema>;

export const adminPayoutRowSchema = z.object({
  businessId: z.string(),
  businessName: z.string(),
  payout: payoutInfoSchema,
  advanceOnlinePaise: paiseSchema,
  paidOutPaise: paiseSchema,
  payoutDuePaise: paiseSchema,
});
export type AdminPayoutRow = z.infer<typeof adminPayoutRowSchema>;

export const recordPayoutRequestSchema = z
  .object({
    businessId: objectIdSchema,
    amountPaise: paiseSchema.min(1),
    reference: z.string().trim().min(3).max(120),
  })
  .strict();

// ---------- web push ----------

export const pushSubscriptionSchema = z
  .object({
    endpoint: z.url({ protocol: /^https$/ }).max(2000),
    keys: z
      .object({ p256dh: z.string().min(10).max(200), auth: z.string().min(10).max(100) })
      .strict(),
  })
  .strict();
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;
