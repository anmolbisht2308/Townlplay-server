import { BALANCE_METHODS, BOOKING_SOURCES, BOOKING_STATUSES } from "@townplay/shared";
import type { Types } from "mongoose";
import { Schema, model, type InferSchemaType } from "mongoose";

const bookingSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    venueId: { type: Schema.Types.ObjectId, required: true },
    businessId: { type: Schema.Types.ObjectId, required: true },
    resourceId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId },
    customer: { name: { type: String }, phone: { type: String } },
    date: { type: String, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    /** UTC instants of the first slot's start and the last slot's end (for jobs and lists). */
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    slots: { type: [String], required: true },
    source: { type: String, enum: BOOKING_SOURCES, required: true },
    status: { type: String, enum: BOOKING_STATUSES, required: true },
    amount: {
      type: new Schema(
        {
          totalPaise: { type: Number, required: true },
          advancePaise: { type: Number, required: true },
          balancePaise: { type: Number, required: true },
          convenienceFeePaise: { type: Number, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
    balanceCollected: {
      method: { type: String, enum: [...BALANCE_METHODS, null], default: null },
      at: { type: Date },
    },
    holdExpiresAt: { type: Date },
    cancellation: {
      type: new Schema(
        {
          by: { type: String, enum: ["player", "owner", "system"], required: true },
          reason: { type: String },
          refundPaise: { type: Number, required: true },
          refundStatus: {
            type: String,
            enum: ["none", "pending", "processed", "failed"],
            default: "none",
          },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    note: { type: String },
    openGameId: { type: Schema.Types.ObjectId },
    /** Split payment set up (shares in bookingShares). */
    split: { type: Boolean, default: false },
    /** source batch: the coaching batch that reserved these slots. */
    batchId: { type: Schema.Types.ObjectId },
    /** Online booking discounted by this membership (plan). */
    membershipId: { type: Schema.Types.ObjectId },
    memberDiscountPaise: { type: Number, default: 0 },
  },
  { collection: "bookings", timestamps: true, versionKey: false },
);
bookingSchema.index({ venueId: 1, date: 1 });
bookingSchema.index({ userId: 1, createdAt: -1 });
bookingSchema.index({ status: 1, holdExpiresAt: 1 });
bookingSchema.index({ status: 1, endsAt: 1 });
bookingSchema.index(
  { batchId: 1, date: 1 },
  { partialFilterExpression: { batchId: { $exists: true } } },
);
bookingSchema.index(
  { membershipId: 1, date: 1 },
  { partialFilterExpression: { membershipId: { $exists: true } } },
);

export type BookingRaw = InferSchemaType<typeof bookingSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
export const BookingModel = model("Booking", bookingSchema);
export type BookingDoc = InstanceType<typeof BookingModel>;
