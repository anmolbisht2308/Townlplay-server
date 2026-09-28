import { SLOT_DURATIONS, SPORTS } from "@townplay/shared";
import type { Types } from "mongoose";
import { Schema, model, type InferSchemaType } from "mongoose";

const pricingRuleSchema = new Schema(
  {
    days: { type: [Number], required: true },
    start: { type: String, required: true },
    end: { type: String, required: true },
    pricePaise: { type: Number, required: true },
  },
  { _id: false },
);

/** A bookable unit (Court 1, Turf A). */
const resourceSchema = new Schema(
  {
    venueId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true, trim: true },
    sport: { type: String, enum: SPORTS, required: true },
    slotDurationMins: { type: Number, enum: SLOT_DURATIONS, required: true },
    maxPlayers: { type: Number, required: true },
    pricingRules: { type: [pricingRuleSchema], required: true },
    isActive: { type: Boolean, default: true },
  },
  { collection: "resources", timestamps: true, versionKey: false },
);

export type ResourceRaw = InferSchemaType<typeof resourceSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
export const ResourceModel = model("Resource", resourceSchema);
export type ResourceDoc = InstanceType<typeof ResourceModel>;
