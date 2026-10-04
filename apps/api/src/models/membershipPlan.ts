import type { Types } from "mongoose";
import { Schema, model, type InferSchemaType } from "mongoose";

/** A membership plan a venue sells (discount on its online bookings). */
const membershipPlanSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, required: true },
    venueId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    durationMonths: { type: Number, required: true },
    pricePaise: { type: Number, required: true },
    discountPercent: { type: Number, required: true },
    /** null = every booking is discounted. */
    bookingsPerMonth: { type: Number, default: null },
    isActive: { type: Boolean, default: true },
  },
  { collection: "membershipPlans", timestamps: true, versionKey: false },
);

export type MembershipPlanRaw = InferSchemaType<typeof membershipPlanSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
export const MembershipPlanModel = model("MembershipPlan", membershipPlanSchema);
