import { BATCH_STATUSES } from "@townplay/shared";
import type { Types } from "mongoose";
import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * A recurring coaching batch. With a court it reserves those slots as `source: batch` bookings
 * (through the slotLocks index) up to `locksUntil`. `seatsTaken` counts members holding a seat
 * (paid or within their payment hold) and is only changed with conditional updates.
 */
const coachingBatchSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, required: true },
    venueId: { type: Schema.Types.ObjectId, required: true, index: true },
    resourceId: { type: Schema.Types.ObjectId, default: null },
    title: { type: String, required: true },
    activity: { type: String, required: true },
    coachName: { type: String, required: true },
    description: { type: String, default: "" },
    days: { type: [Number], required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    capacity: { type: Number, required: true },
    seatsTaken: { type: Number, default: 0, min: 0 },
    monthlyFeePaise: { type: Number, required: true },
    startDate: { type: String, required: true },
    endDate: { type: String, default: null },
    /** Slots are reserved up to this date (inclusive). */
    locksUntil: { type: String, default: null },
    status: { type: String, enum: BATCH_STATUSES, default: "active" },
  },
  { collection: "coachingBatches", timestamps: true, versionKey: false },
);

export type CoachingBatchRaw = InferSchemaType<typeof coachingBatchSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
export const CoachingBatchModel = model("CoachingBatch", coachingBatchSchema);
