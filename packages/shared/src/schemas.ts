import { z } from "zod";
import { LANGS, ROLES } from "./constants.js";
import { isDateString, isTimeString } from "./time.js";

/** Every API error: `{ error: { code, message, details? } }`. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const roleSchema = z.enum(ROLES);
export const langSchema = z.enum(LANGS);

/** Integer paise, never negative. */
export const paiseSchema = z.number().int().nonnegative();
/** IST calendar date "YYYY-MM-DD". */
export const dateStringSchema = z.string().refine(isDateString, "Expected a date YYYY-MM-DD");
/** IST wall-clock time "HH:mm". */
export const timeStringSchema = z.string().refine(isTimeString, "Expected a time HH:mm");
/** Indian mobile number, stored as 10 digits (unverified until phone OTP exists). */
export const phoneSchema = z.string().regex(/^[6-9]\d{9}$/, "Expected a 10-digit mobile number");

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
  db: z.enum(["up", "down"]),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const meSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  phone: z.string().nullable(),
  roles: z.array(roleSchema),
  lang: langSchema,
  cityId: z.string().nullable(),
});
export type Me = z.infer<typeof meSchema>;

/** PATCH /v1/me — default-free so a partial body never resets fields. */
export const updateMeSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    phone: phoneSchema.nullable(),
    lang: langSchema,
  })
  .partial()
  .strict();
export type UpdateMe = z.infer<typeof updateMeSchema>;
