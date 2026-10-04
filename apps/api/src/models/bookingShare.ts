import { SHARE_STATUSES } from "@townplay/shared";
import type { Types } from "mongoose";
import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * An online payment towards a confirmed booking's venue balance: an open-game spot (`game`)
 * or a split-payment share (`split`). `activeKey` ("<gameId>:<userId>") is set while a game
 * spot is held or paid, so the unique index stops one person joining twice.
 */
const bookingShareSchema = new Schema(
  {
    bookingId: { type: Schema.Types.ObjectId, required: true, index: true },
    businessId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: ["game", "split"], required: true },
    gameId: { type: Schema.Types.ObjectId, index: true },
    userId: { type: Schema.Types.ObjectId },
    name: { type: String, required: true },
    phone: { type: String },
    amountPaise: { type: Number, required: true },
    feePaise: { type: Number, required: true },
    status: { type: String, enum: SHARE_STATUSES, required: true },
    holdExpiresAt: { type: Date },
    /** Split shares: capability token in the pay link. */
    token: { type: String, unique: true, sparse: true },
    activeKey: { type: String, unique: true, sparse: true },
    paidAt: { type: Date },
    refundPaise: { type: Number, default: 0 },
  },
  { collection: "bookingShares", timestamps: true, versionKey: false },
);
bookingShareSchema.index({ status: 1, holdExpiresAt: 1 });

export type BookingShareRaw = InferSchemaType<typeof bookingShareSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
export const BookingShareModel = model("BookingShare", bookingShareSchema);
export type BookingShareDoc = InstanceType<typeof BookingShareModel>;
