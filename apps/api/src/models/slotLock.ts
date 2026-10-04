import type { Types } from "mongoose";
import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * The anti-double-booking mechanism (docs/PLAN.md §3). One document per booked slot; the unique
 * index lets only one booking hold a slot. Holds carry `expiresAt` (TTL); confirmed, walk-in,
 * phone and block bookings have no `expiresAt` and stay until cancelled.
 */
const slotLockSchema = new Schema(
  {
    resourceId: { type: Schema.Types.ObjectId, required: true },
    date: { type: String, required: true },
    startTime: { type: String, required: true },
    bookingId: { type: Schema.Types.ObjectId, required: true, index: true },
    expiresAt: { type: Date },
  },
  { collection: "slotLocks", versionKey: false },
);
slotLockSchema.index({ resourceId: 1, date: 1, startTime: 1 }, { unique: true });
slotLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type SlotLockRaw = InferSchemaType<typeof slotLockSchema> & { _id: Types.ObjectId };
export const SlotLockModel = model("SlotLock", slotLockSchema);
