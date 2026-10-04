import { Schema, model } from "mongoose";

/** Single global settings document (`_id: "global"`), edited by admins. */
const settingsSchema = new Schema(
  {
    _id: { type: String, required: true },
    convenienceFee: {
      flatPaise: { type: Number, required: true },
      percent: { type: Number, required: true },
    },
  },
  { collection: "settings", timestamps: true, versionKey: false },
);

export const SettingsModel = model("Settings", settingsSchema);
