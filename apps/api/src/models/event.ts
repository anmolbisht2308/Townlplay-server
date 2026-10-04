import { EVENT_STATUSES, EVENT_TYPES } from "@townplay/shared";
import type { Types } from "mongoose";
import { Schema, model, type InferSchemaType } from "mongoose";

const tierSchema = new Schema({
  name: { type: String, required: true },
  pricePaise: { type: Number, required: true },
  capacity: { type: Number, required: true },
  /** Decremented atomically when tickets are held; never below 0 (filter `remaining >= qty`). */
  remaining: { type: Number, required: true, min: 0 },
});

const eventSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, required: true, index: true },
    cityId: { type: Schema.Types.ObjectId, required: true },
    citySlug: { type: String, required: true },
    venueId: { type: Schema.Types.ObjectId },
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true },
    type: { type: String, enum: EVENT_TYPES, required: true },
    description: { type: String, default: "" },
    photos: { type: [new Schema({ url: String, publicId: String }, { _id: false })], default: [] },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    address: { type: String, required: true },
    area: { type: String, default: "" },
    geo: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true },
    },
    ageLimit: { type: Number },
    tiers: { type: [tierSchema], required: true },
    status: { type: String, enum: EVENT_STATUSES, default: "draft" },
    reviewNote: { type: String },
    businessActive: { type: Boolean, default: false },
    cancelReason: { type: String },
  },
  { collection: "events", timestamps: true, versionKey: false },
);
eventSchema.index({ cityId: 1, slug: 1 }, { unique: true });
eventSchema.index({ cityId: 1, status: 1, startsAt: 1 });
eventSchema.index({ geo: "2dsphere" });

export type EventRaw = InferSchemaType<typeof eventSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
export const EventModel = model("Event", eventSchema);
export type EventDoc = InstanceType<typeof EventModel>;
