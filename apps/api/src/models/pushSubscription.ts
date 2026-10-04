import { Schema, model } from "mongoose";

const pushSubscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: { p256dh: { type: String, required: true }, auth: { type: String, required: true } },
  },
  { collection: "pushSubscriptions", timestamps: true, versionKey: false },
);

export const PushSubscriptionModel = model("PushSubscription", pushSubscriptionSchema);
