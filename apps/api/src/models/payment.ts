import { PAYMENT_PROVIDERS, PAYMENT_STATUSES } from "@townplay/shared";
import type { Types } from "mongoose";
import { Schema, model, type InferSchemaType } from "mongoose";

const refundSchema = new Schema(
  {
    razorpayRefundId: { type: String, required: true },
    amountPaise: { type: Number, required: true },
    status: { type: String, enum: ["pending", "processed", "failed"], required: true },
    reason: { type: String },
    at: { type: Date, required: true },
  },
  { _id: false },
);

/** One online payment (Razorpay order) and its refunds and Route transfer. */
const paymentSchema = new Schema(
  {
    kind: {
      type: String,
      enum: ["booking_advance", "booking_share", "ticket", "membership"],
      required: true,
    },
    /** groupShare = a bookingShares document (open-game spot or split share); membership = memberships. */
    refType: {
      type: String,
      enum: ["booking", "ticketOrder", "groupShare", "membership"],
      required: true,
    },
    refId: { type: Schema.Types.ObjectId, required: true, index: true },
    businessId: { type: Schema.Types.ObjectId, required: true, index: true },
    userId: { type: Schema.Types.ObjectId },
    provider: { type: String, enum: PAYMENT_PROVIDERS, required: true },
    amountPaise: { type: Number, required: true },
    /** Split of amountPaise: the venue's advance and the platform's convenience fee. */
    advancePaise: { type: Number, required: true },
    feePaise: { type: Number, required: true },
    razorpayOrderId: { type: String, required: true, unique: true },
    razorpayPaymentId: { type: String, sparse: true, unique: true },
    status: { type: String, enum: PAYMENT_STATUSES, default: "created" },
    paidAt: { type: Date },
    refunds: { type: [refundSchema], default: [] },
    transfer: {
      type: new Schema(
        {
          razorpayTransferId: { type: String, required: true },
          accountId: { type: String, required: true },
          amountPaise: { type: Number, required: true },
          reversedPaise: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      default: undefined,
    },
    rawEvents: { type: [Schema.Types.Mixed], default: [] },
  },
  { collection: "payments", timestamps: true, versionKey: false },
);

export type PaymentRaw = InferSchemaType<typeof paymentSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
export const PaymentModel = model("Payment", paymentSchema);
export type PaymentDoc = InstanceType<typeof PaymentModel>;
