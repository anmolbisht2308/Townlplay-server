import { Schema, model } from "mongoose";

/** A manual payout an admin made to a business (PAYOUTS_MODE=manual). */
const payoutSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, required: true, index: true },
    amountPaise: { type: Number, required: true },
    reference: { type: String, required: true },
    recordedBy: { type: Schema.Types.ObjectId, required: true },
  },
  { collection: "payouts", timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

export const PayoutModel = model("Payout", payoutSchema);
