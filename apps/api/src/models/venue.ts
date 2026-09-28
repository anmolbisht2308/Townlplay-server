import { AMENITIES, SPORTS, VENUE_CATEGORIES, VENUE_STATUSES } from "@townplay/shared";
import type { Types } from "mongoose";
import { Schema, model, type InferSchemaType } from "mongoose";

const dayHoursSchema = new Schema(
  {
    open: { type: String, required: true },
    close: { type: String, required: true },
    closed: Boolean,
  },
  { _id: false },
);

const venueSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, required: true, index: true },
    cityId: { type: Schema.Types.ObjectId, required: true },
    citySlug: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true },
    category: { type: String, enum: VENUE_CATEGORIES, required: true },
    sports: { type: [{ type: String, enum: SPORTS }], default: [] },
    amenities: { type: [{ type: String, enum: AMENITIES }], default: [] },
    description: { type: String, default: "" },
    address: { type: String, required: true },
    area: { type: String, required: true, trim: true },
    geo: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    photos: {
      type: [new Schema({ url: String, publicId: String }, { _id: false })],
      default: [],
    },
    openingHours: { type: [dayHoursSchema], required: true },
    bookingPolicy: {
      advancePercent: { type: Number, required: true },
      cancellationCutoffHours: { type: Number, required: true },
      refundPercentBeforeCutoff: { type: Number, required: true },
    },
    status: { type: String, enum: VENUE_STATUSES, default: "draft" },
    reviewNote: { type: String },
    /** Denormalised: the owning business is active. Public listing needs it and status "live". */
    businessActive: { type: Boolean, default: false },
    /** Denormalised: cheapest band across active resources, for listing cards. */
    minPricePaise: { type: Number },
  },
  { collection: "venues", timestamps: true, versionKey: false },
);
venueSchema.index({ geo: "2dsphere" });
venueSchema.index({ name: "text", area: "text", sports: "text" });
venueSchema.index({ cityId: 1, status: 1, category: 1 });
venueSchema.index({ cityId: 1, slug: 1 }, { unique: true });

export type VenueRaw = InferSchemaType<typeof venueSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
export const VenueModel = model("Venue", venueSchema);
export type VenueDoc = InstanceType<typeof VenueModel>;
