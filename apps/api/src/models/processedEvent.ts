import { Schema, model } from "mongoose";

/** Webhook event ids already handled; inserting a duplicate id means "replay, do nothing". */
const processedEventSchema = new Schema(
  {
    _id: { type: String, required: true },
    provider: { type: String, required: true },
    type: { type: String, required: true },
    at: { type: Date, default: () => new Date() },
  },
  { collection: "processedEvents", versionKey: false },
);

export const ProcessedEventModel = model("ProcessedEvent", processedEventSchema);
