import { MEMBERSHIP_KINDS, MEMBERSHIP_STATUSES } from "@townplay/shared";
import type { Types } from "mongoose";
import { Schema, model, type InferSchemaType } from "mongoose";

/** One membership period (plan or batch) bought by a player. A renewal is a new document. */
const membershipSchema = new Schema(
  {
    kind: { type: String, enum: MEMBERSHIP_KINDS, required: true },
    planId: { type: Schema.Types.ObjectId },
    batchId: { type: Schema.Types.ObjectId },
    businessId: { type: Schema.Types.ObjectId, required: true },
    venueId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    member: {
      type: new Schema(
        { name: { type: String, required: true }, phone: { type: String, required: true } },
        { _id: false },
      ),
      required: true,
    },
    code: { type: String, required: true },
    startsOn: { type: String, required: true },
    endsOn: { type: String, required: true },
    pricePaise: { type: Number, required: true },
    convenienceFeePaise: { type: Number, required: true },
    status: { type: String, enum: MEMBERSHIP_STATUSES, required: true },
    holdExpiresAt: { type: Date },
    /** Batch memberships: this period holds one of the batch's seats. */
    seatHeld: { type: Boolean, default: false },
    renewalOf: { type: Schema.Types.ObjectId },
    paidAt: { type: Date },
    reminderSentAt: { type: Date },
    cancellation: {
      type: new Schema(
        {
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
  },
  { collection: "memberships", timestamps: true, versionKey: false },
);
membershipSchema.index({ userId: 1, createdAt: -1 });
membershipSchema.index({ venueId: 1, status: 1, endsOn: 1 });
membershipSchema.index({ batchId: 1, status: 1 });
membershipSchema.index({ status: 1, holdExpiresAt: 1 });
/** At most one open renewal per membership. */
membershipSchema.index(
  { renewalOf: 1 },
  {
    unique: true,
    partialFilterExpression: {
      renewalOf: { $exists: true },
      status: { $in: ["pending_payment", "active"] },
    },
  },
);

export type MembershipRaw = InferSchemaType<typeof membershipSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
export const MembershipModel = model("Membership", membershipSchema);
export type MembershipDoc = InstanceType<typeof MembershipModel>;
