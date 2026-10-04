import { GAME_STATUSES, SKILL_LEVELS, SPORTS } from "@townplay/shared";
import type { Types } from "mongoose";
import { Schema, model, type InferSchemaType } from "mongoose";

/** A booking the host opened to other players. `filledSpots` counts held + paid spots. */
const openGameSchema = new Schema(
  {
    bookingId: { type: Schema.Types.ObjectId, required: true, unique: true },
    hostUserId: { type: Schema.Types.ObjectId, required: true, index: true },
    hostFirstName: { type: String, required: true },
    businessId: { type: Schema.Types.ObjectId, required: true },
    venueId: { type: Schema.Types.ObjectId, required: true },
    resourceId: { type: Schema.Types.ObjectId, required: true },
    cityId: { type: Schema.Types.ObjectId, required: true },
    citySlug: { type: String, required: true },
    sport: { type: String, enum: SPORTS, required: true },
    skillLevel: { type: String, enum: SKILL_LEVELS, required: true },
    date: { type: String, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    startsAt: { type: Date, required: true },
    joinCutoffAt: { type: Date, required: true },
    totalSpots: { type: Number, required: true },
    filledSpots: { type: Number, default: 0, min: 0 },
    pricePerHeadPaise: { type: Number, required: true },
    note: { type: String },
    status: { type: String, enum: GAME_STATUSES, default: "open" },
    cutoffNotifiedAt: { type: Date },
  },
  { collection: "openGames", timestamps: true, versionKey: false },
);
openGameSchema.index({ cityId: 1, status: 1, startsAt: 1 });

export type OpenGameRaw = InferSchemaType<typeof openGameSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
export const OpenGameModel = model("OpenGame", openGameSchema);
