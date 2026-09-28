import { Schema, model, type InferSchemaType } from "mongoose";

const citySchema = new Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    state: { type: String, required: true },
    isActive: { type: Boolean, default: true },
  },
  { collection: "cities", timestamps: true, versionKey: false },
);

export type CityDoc = InferSchemaType<typeof citySchema>;
export const CityModel = model("City", citySchema);
